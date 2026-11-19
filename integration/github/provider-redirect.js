// Azure's custom key header is forwarded even across origins by native fetch.
// Its existing per-request X-ClientTraceId lets the worker associate Chromium's
// redirect observation with this particular fetch, including concurrent calls.
const activeAzureTraces = new Map();
const observedAzureHosts = new Set();
function observeAzureHost(url) {
  // Keep one subscription per provider host for this worker's lifetime.
  // Re-registering between hops races Chromium's network event dispatch.
  const pattern = url.protocol + '//' + url.hostname + '/*';
  if (observedAzureHosts.has(pattern)) return;
  const filter = { urls: [pattern], types: ['xmlhttprequest'], tabId: -1 };
  const initiator = chrome.runtime.getURL('').replace(/\/$/, '');
  chrome.webRequest.onSendHeaders.addListener(details => {
    if (details.initiator !== initiator) return;
    for (const [trace, hop] of activeAzureTraces) {
      if (details.url === hop.endpoint && details.method === hop.method &&
          details.requestHeaders?.some(h => h.name.toLowerCase() === 'x-clienttraceid' && h.value === trace)) {
        hop.requestId = details.requestId;
        return;
      }
    }
  }, filter, ['requestHeaders']);
  chrome.webRequest.onBeforeRedirect.addListener(details => {
    if (details.initiator !== initiator) return;
    for (const hop of activeAzureTraces.values()) {
      if (details.requestId === hop.requestId && details.url === hop.endpoint) {
        hop.finish({ redirectUrl: details.redirectUrl, statusCode: details.statusCode });
        return;
      }
    }
  }, filter);
  observedAzureHosts.add(pattern);
}

async function githubProviderFetch(url, init) {
  const headers = new Headers(init.headers);
  const options = { ...init, headers, credentials: 'omit' };
  if ([...headers.keys()].every(key => ['content-type', 'authorization'].includes(key))) {
    return fetch(url, { ...options, redirect: 'follow' });
  }
  const trace = headers.get('x-clienttraceid');
  if (!headers.has('ocp-apim-subscription-key') || !trace || !chrome.webRequest || new URL(url).hostname.includes('*')) {
    return fetch(url, { ...options, redirect: 'error' });
  }
  if (activeAzureTraces.has(trace)) throw Error('重复的 Azure 请求标识');
  const start = new URL(url);
  observeAzureHost(start);
  const current = new URL(start);
  current.hash = '';
  options.redirect = 'manual';
  try {
    for (let count = 0; ; count++) {
      const { response, redirect } = await fetchAzureHop(current, options, trace);
      if (!redirect) return response;
      const next = new URL(redirect.redirectUrl, current);
      if (next.origin !== start.origin || next.username || next.password || !['http:', 'https:'].includes(next.protocol)) {
        throw Error('翻译服务重定向到了其他来源');
      }
      if (count >= 20) throw Error('翻译服务的重定向次数过多');
      if (([301,302].includes(redirect.statusCode) && options.method === 'POST') ||
          (redirect.statusCode === 303 && options.method !== 'GET' && options.method !== 'HEAD')) {
        options.method = 'GET';
        delete options.body;
        for (const key of ['content-encoding', 'content-language', 'content-location', 'content-type']) headers.delete(key);
      }
      current.href = next.href;
      current.hash = '';
    }
  } finally {
    activeAzureTraces.delete(trace);
  }
}

async function fetchAzureHop(url, options, trace) {
  const endpoint = url.href;
  let timer, finish;
  const observed = new Promise(resolve => { finish = resolve; });
  const stopWaiting = () => finish(null);
  activeAzureTraces.set(trace, { endpoint, method: options.method, finish });
  try {
    const response = await fetch(endpoint, options);
    if (response.type !== 'opaqueredirect') return { response };
    // The Fetch API deliberately hides Location. Wait briefly for the
    // independently delivered webRequest event, and fail closed if absent.
    options.signal?.throwIfAborted();
    options.signal?.addEventListener('abort', stopWaiting, { once: true });
    timer = setTimeout(stopWaiting, 2000);
    const redirect = await observed;
    options.signal?.throwIfAborted();
    if (!redirect || ![301,302,303,307,308].includes(redirect.statusCode)) throw Error('无法确认翻译服务的重定向目标');
    return { response, redirect };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stopWaiting);
  }
}
