import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const readSupport = file => readFile(new URL('./github/' + file, import.meta.url), 'utf8');
const closure = (...parts) => ['(() => {', "'use strict';", ...parts, '})();', ''].join('\n');

function replaceOnce(source, marker, replacement) {
  const pieces = source.split(marker);
  if (pieces.length !== 2) throw Error('不支持的 GitHub 扩展结构：' + marker);
  return pieces.join(replacement);
}

function extract(source, pattern) {
  const result = source.match(pattern);
  if (!result) throw Error('无法识别 GitHub 版本：' + pattern);
  return result[0];
}

function getFunction(source, name) {
  return extract(source, new RegExp('^    function ' + name + '\\([^\\n]*?\\) \\{[\\s\\S]*?^    \\}', 'm'));
}

const scopeStorage = source => source.replaceAll('chrome.storage.', 'githubStorage.');
const scopeRefresh = source => replaceOnce(source, "'refresh-page'", "'github-zh:refresh-page'");

function integrateDom(source) {
  // GitHub localizes the interface, while the README may still be in English.
  // Keep the document language supplied by GitHub for Immersive's detector.
  const initLang = extract(source, /        \/\/ 设置中文环境\n[\s\S]*?\.observe\(document\.documentElement, \{ attributeFilter: \['lang'\] \}\);\n/);
  source = replaceOnce(source, initLang, '');
  source = replaceOnce(source, '                document.documentElement.lang = CONFIG.LANG;\n', '');
  for (const key of ['ignoreSelectors', 'ignoreMutationSelectors']) {
    source = replaceOnce(source, key + ': [', key + ': [\n                immersiveUi,');
  }
  const traverse = 'function traverseNode(rootNode) {';
  source = replaceOnce(source, traverse, traverse + '\n        if ((rootNode.parentElement?.closest(immersiveUi)) || rootNode.matches?.(immersiveUi)) return;');
  const readme = 'async function translateReadmeElement(readmeEl, reason, debugContext = null) {';
  source = replaceOnce(source, readme, readme + '\n        if (!getProviderConfig().ok || !canTranslateGithubBlock(readmeEl)) return;');
  source = replaceOnce(source, 'for (const aboutEl of aboutElements) {', 'for (const aboutEl of aboutElements) {\n            if (!canTranslateGithubBlock(aboutEl)) continue;');
  // An HTTP error, empty response, or skipped node must never leave an
  // untouched block marked as translated. Acquire ownership at the DOM write
  // and recheck the other engine after any async provider/cache lookup.
  const writeNode = 'task.node.data = task.rawText.replace(task.trimmedText, translated);';
  if (source.split(writeNode).length !== 3) throw Error('无法识别 GitHub 译文写入位置');
  const guard = 'if (githubCandidates.has(rootEl) && (!FeatureSet.enable_extension || !FeatureSet.enable_readme_translation || !claimGithubBlock(rootEl))) return;';
  source = source.replaceAll(writeNode, guard + '\n                ' + writeNode);
  const cachedWrite = 'applyReadmeHtml(readmeEl, cacheHit.translatedHtml);';
  source = replaceOnce(source, cachedWrite,
    'if (!FeatureSet.enable_extension || !FeatureSet.enable_readme_translation || !canTranslateGithubBlock(readmeEl)) return;\n' +
    '                if (getStableReadmeTextHash(cacheHit.translatedHtml) !== getStableReadmeTextHash(state.originalHtml)) {\n' +
    '                    if (!claimGithubBlock(readmeEl)) return;\n' +
    '                }\n                ' + cachedWrite);
  const writeHtml = 'function applyReadmeHtml(readmeEl, html) {';
  source = replaceOnce(source, writeHtml, writeHtml + '\n        if (!canTranslateGithubBlock(readmeEl)) return;');
  const restore = 'function restoreReadmeTranslation() {';
  source = replaceOnce(source, restore, restore + '\n        const owned = getReadmeRootElement()?.hasAttribute("data-github-zh-owned");\n        releaseGithubBlocks();\n        if (!owned) return;');
  const toggles = 'function applyBatchedFeatureToggles(changedKeys) {';
  source = replaceOnce(source, toggles, toggles + '\n        if (!getProviderConfig().ok) restoreReadmeTranslation();');
  // GitHub's AI discussion translation uses a clone of the original. Remove
  // the other engine's rendered text from that clone before processing.
  const clone = "translatedEl.classList.add('ghcn-discussion-translation-panel');";
  source = replaceOnce(source, clone, clone + '\n        translatedEl.querySelectorAll(immersiveUi).forEach(node => node.remove());\n        translatedEl.classList.add("imt-notranslate");');
  const tldrClone = 'const clone = sourceEl.cloneNode(true);';
  source = replaceOnce(source, tldrClone, tldrClone + '\n        clone.querySelectorAll(immersiveUi).forEach(node => node.remove());');
  for (const name of ['ghcn-discussion-translate-toolbar', 'ghcn-collab-overlay', 'ghcn-collab-btn', 'ghcn-tldr-card', 'ghcn-tldr-header-btn btn btn-sm Button--primary Button--small Button tooltipped tooltipped-w']) {
    source = replaceOnce(source, ".className = '" + name + "';", ".className = '" + name + " imt-notranslate';");
  }
  return source;
}

async function workerSource(content, background, manifest) {
  // Reuse the selected provider's exact URL normalization from the input.
  const provider = getFunction(content, 'getProviderConfig').replace('getProviderConfig()', 'activeProviderConfig(FeatureSet)');
  const providerHelpers = ['createHash', 'normalizeUrl', 'normalizeOpenAiEndpoint', 'parseApiUrl', 'getProviderDefaultBasePath'];
  const functions = providerHelpers.map(name => getFunction(content, name));
  const defaults = extract(content, /^    const STORAGE_DEFAULTS = \{[\s\S]*?^    \};/m);
  const origins = manifest.content_scripts[0].matches.map(pattern => new URL(pattern).origin);
  const listenerStart = 'chrome.runtime.onMessage.addListener(';
  const listener = listenerStart + background.split(listenerStart)[1];
  let guarded = replaceOnce(listener, "const { url, method", "await checkGithubRequest(message, _sender);\n      const { url, method");
  guarded = replaceOnce(guarded, 'await fetch(url, {', 'await githubProviderFetch(url, {');
  const updates = [
    'async function showGithubUpdateBadge() {',
    '  if (await chrome.action.getBadgeText({})) return;',
    '  await chrome.action.setBadgeBackgroundColor({ color: "#1f883d" });',
    '  await chrome.action.setBadgeText({ text: "新" });',
    '}',
    'chrome.runtime.onInstalled.addListener(async () => {',
    '  const version = ' + JSON.stringify(manifest.version) + ';',
    '  const { componentVersion: previousVersion } = await githubStorage.local.get("componentVersion");',
    '  const changes = { componentVersion: version };',
    '  if (previousVersion && previousVersion !== version) {',
    '    const url = ' + JSON.stringify(manifest.homepage_url) + ' + "#v" + version.replaceAll(".", "-");',
    '    changes.update_notice = { version, previousVersion, url };',
    '  }',
    '  await githubStorage.local.set(changes);',
    '  if (changes.update_notice) await showGithubUpdateBadge();',
    '});',
    'chrome.runtime.onStartup.addListener(async () => {',
    '  const { update_notice } = await githubStorage.local.get("update_notice");',
    '  if (update_notice?.version) await showGithubUpdateBadge();',
    '});',
  ].join('\n');
  return [defaults, "const FIXED_TARGET_LANG = 'zh-CN';", ...functions, provider,
    'const githubOrigins = ' + JSON.stringify(origins) + ';',
    await readSupport('provider.js'), await readSupport('provider-redirect.js'), updates, guarded].join('\n');
}

export async function integrateGithub({githubDir, outDir}) {
  const destination = path.join(outDir, 'github-zh');
  const read = async file => (await readFile(path.join(githubDir, file), 'utf8')).replaceAll('\r\n', '\n');
  const [manifestText, dict, content, background, popup, options, storage, dom] = await Promise.all([
    ...['manifest.json', 'locals.js', 'content.js', 'background.js', 'popup/popup.js', 'options/options.js'].map(read),
    readSupport('storage.js'), readSupport('dom.js'),
  ]);
  const manifest = JSON.parse(manifestText);
  if (manifest.version !== '3.1.4') throw Error('需要 GitHub 汉化版本 3.1.4');
  let popupSource = scopeRefresh(scopeStorage(popup));
  popupSource = replaceOnce(popupSource, 'chrome.runtime.openOptionsPage();',
    "chrome.tabs.create({url: chrome.runtime.getURL('github-zh/options/options.html')});");
  popupSource = replaceOnce(popupSource, "await chrome.action.setBadgeText({ text: '' });",
    "if (await chrome.action.getBadgeText({}) === '新') await chrome.action.setBadgeText({ text: '' });");
  const scripts = {
    'content.js': closure(storage, dom, dict, scopeRefresh(scopeStorage(integrateDom(content)))),
    'background.js': closure(storage, await workerSource(content, background, manifest)),
    'popup/popup.js': closure(storage, popupSource),
    'options/options.js': closure(storage, scopeStorage(options)),
  };
  await Promise.all(['popup', 'options'].map(name => mkdir(path.join(destination, name), {recursive: true})));
  await Promise.all([
    cp(path.join(githubDir, 'assets'), path.join(destination, 'assets'), {recursive: true}),
    ...Object.entries(scripts).map(([file, source]) => writeFile(path.join(destination, file), source)),
    ...['popup/popup.html', 'options/options.html'].map(async file => {
      const html = replaceOnce(await read(file), '</head>', '<link rel="icon" href="../assets/icons/icon32.png">\n</head>');
      await writeFile(path.join(destination, file), html);
    }),
    ...['popup/popup.css', 'options/options.css'].map(file =>
      copyFile(path.join(githubDir, file), path.join(destination, file))),
  ]);
}
