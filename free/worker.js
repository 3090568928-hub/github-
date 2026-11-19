(() => {
  'use strict';

  const MAX_SEGMENT = 2400;
  const MAX_BATCH_CHARS = 4800;
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;

  function pump() {
    while (active < 3 && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active--;
        pump();
      });
    }
  }

  function schedule(task) {
    return new Promise((resolve, reject) => {
      if (queue.length >= 160) throw new Error('待译内容较多，请稍后重试。');
      queue.push({ task, resolve, reject });
      pump();
    });
  }

  function language(value, allowAuto) {
    if (allowAuto && value === 'auto') return value;
    if (typeof value !== 'string' || !/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(value)) {
      throw new Error('不支持该语言。');
    }
    return Intl.getCanonicalLocales(value)[0];
  }

  function edgeLanguage(lang) {
    if (['zh', 'zh-CN', 'zh-SG', 'zh-Hans'].includes(lang)) return 'zh-Hans';
    if (['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant'].includes(lang)) return 'zh-Hant';
    return lang;
  }

  function googleLanguage(lang) {
    if (edgeLanguage(lang) === 'zh-Hans') return 'zh-CN';
    if (edgeLanguage(lang) === 'zh-Hant') return 'zh-TW';
    return lang;
  }

  async function post(url, body, type) {
    const response = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': type },
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }

  async function edge(texts, source, target) {
    const url = new URL('https://edge.microsoft.com/translate/translatetext');
    if (source !== 'auto') url.searchParams.set('from', edgeLanguage(source));
    url.searchParams.set('to', edgeLanguage(target));
    url.searchParams.set('isEnterpriseClient', 'false');
    const result = await post(url, JSON.stringify(texts), 'application/json');
    return result.map(row => row?.translations?.[0]?.text);
  }

  async function google(texts, source, target) {
    const url = new URL('https://translate.googleapis.com/translate_a/t');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', googleLanguage(source));
    url.searchParams.set('tl', googleLanguage(target));
    const body = new URLSearchParams();
    for (const text of texts) body.append('q', text);
    const result = await post(url, body, 'application/x-www-form-urlencoded;charset=UTF-8');
    return result.map(row => Array.isArray(row) ? row[0] : row);
  }

  const retryAfter = new Map();
  async function translateBatch(texts, source, target) {
    for (const provider of [edge, google]) {
      if ((retryAfter.get(provider) || 0) > Date.now()) continue;
      try {
        const rows = await provider(texts, source, target);
        if (rows.length !== texts.length || rows.some(text => typeof text !== 'string' || !text.trim())) {
          throw new Error('Invalid response');
        }
        return rows;
      } catch (error) {
        if (error.message === '429') retryAfter.set(provider, Date.now() + 60000);
        else if (error instanceof TypeError || error.name === 'TimeoutError' || /^5\d\d$/.test(error.message)) {
          retryAfter.set(provider, Date.now() + 15000);
        }
      }
    }
    throw new Error('免费翻译服务暂时不可用，请稍后重试。');
  }

  function split(text) {
    const pieces = [];
    while (text.length > MAX_SEGMENT) {
      const head = text.slice(0, MAX_SEGMENT);
      // Prefer a sentence boundary, then a word boundary. Avoid splitting a surrogate pair.
      const sentence = Math.max(...['\n', '. ', '? ', '! ', '。', '？', '！'].map(sep => head.lastIndexOf(sep)));
      const space = head.lastIndexOf(' ');
      let stop = MAX_SEGMENT;
      if (sentence >= MAX_SEGMENT / 2) stop = sentence + 1;
      else if (space >= MAX_SEGMENT / 2) stop = space + 1;
      if (/[\uD800-\uDBFF]/.test(text[stop - 1])) stop--;
      pieces.push(text.slice(0, stop));
      text = text.slice(stop);
    }
    pieces.push(text);
    return pieces;
  }

  function remember(key, value) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > 650) cache.delete(cache.keys().next().value);
    return value;
  }

  async function translate(message) {
    const { texts } = message;
    if (!Array.isArray(texts) || texts.length > 64 || texts.some(t => typeof t !== 'string')
        || texts.reduce((sum, t) => sum + t.length, 0) > 65536) {
      throw new Error('每批最多可翻译 64 段、65536 个字符。');
    }
    const source = language(message.source ?? 'auto', true);
    const target = language(message.target ?? 'zh-CN', false);
    if (edgeLanguage(source) === edgeLanguage(target)) return texts;

    const groups = texts.map(split);
    const results = new Map();
    let batch = [], chars = 0;
    const prefix = source + '/' + target + ':';
    function submit() {
      if (!batch.length) return;
      const chunk = batch;
      const rows = schedule(() => translateBatch(chunk, source, target));
      for (const [index, text] of chunk.entries()) {
        const key = prefix + text;
        const item = rows.then(values => remember(key, values[index])).finally(() => pending.delete(key));
        pending.set(key, item);
        results.set(text, item);
      }
      batch = [];
      chars = 0;
    }

    for (const group of groups) {
      for (const piece of group) {
        const text = piece.trim();
        if (!text || results.has(text)) continue;
        const key = prefix + text;
        if (cache.has(key)) {
          results.set(text, remember(key, cache.get(key)));
        } else if (pending.has(key)) {
          results.set(text, pending.get(key));
        } else {
          if (batch.length >= 24 || chars + text.length > MAX_BATCH_CHARS) submit();
          batch.push(text);
          chars += text.length;
          results.set(text, null);
        }
      }
    }
    submit();
    await Promise.all([...results].map(async ([key, value]) => results.set(key, await value)));
    return groups.map(group => group.map(piece => {
      const trimmed = piece.trim();
      return trimmed ? piece.replace(trimmed, () => results.get(trimmed)) : piece;
    }).join(''));
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'translate') return false;
    translate(message).then(
      translations => reply({ translations }),
      error => reply({ error: error.message || '翻译失败，请重试。' }),
    );
    return true;
  });
})();
