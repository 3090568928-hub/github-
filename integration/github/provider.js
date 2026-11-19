// The options page tests a URL entered by the user before saving. A content
// script may only call the endpoint for the saved, active provider.
async function checkGithubRequest(message, sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId > 0) throw Error('无效的扩展请求来源');
  const optionsUrl = chrome.runtime.getURL('github-zh/options/options.html');
  const isOptions = sender.url === optionsUrl;
  if (!isOptions && !githubOrigins.includes(new URL(sender.url).origin)) throw Error('来源站点未获授权');
  const {url, method} = message.payload || {};
  const address = new URL(url);
  const localHttp = address.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(address.hostname);
  if (method !== 'POST' || address.username || address.password || (address.protocol !== 'https:' && !localHttp)) {
    throw Error('无效的翻译服务请求');
  }
  if (isOptions) return;
  const settings = await githubStorage.sync.get(STORAGE_DEFAULTS);
  if (!settings.enable_extension) throw Error('GitHub 汉化已关闭');
  const config = activeProviderConfig(settings);
  if (!config.ok) throw Error(config.message);
  const allowed = new URL(config.url);
  if (config.provider === 'google') allowed.searchParams.set('key', config.key);
  if (config.provider === 'azure') {
    allowed.searchParams.set('api-version', '3.0');
    allowed.searchParams.set('to', 'zh-Hans');
  }
  if (address.href !== allowed.href) throw Error('请求与当前配置的翻译服务不匹配');
}
