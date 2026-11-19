const bundlePreferencesReady = (async () => {
  const area = chrome.storage.local;
  const marker = 'translation-bundle:github-auto-red-v1';
  const languageMarker = 'translation-bundle:default-languages-v1';
  const configKey = 'fullLocalUserConfig';
  const applied = await area.get([marker, languageMarker]);
  if (applied[marker] && applied[languageMarker]) return;

  const current = (await area.get(configKey))[configKey] ?? {};
  let next = current;
  if (!applied[marker]) next = applyGithubReadingPreferences(current);
  if (!applied[languageMarker] && (!next.targetLanguage || !next.interfaceLanguage)) {
    next = {
      ...next,
      targetLanguage: next.targetLanguage || 'zh-CN',
      interfaceLanguage: next.interfaceLanguage || 'zh-CN',
    };
  }
  const updates = { [marker]: true, [languageMarker]: true };
  if (next !== current) updates[configKey] = next;
  await area.set(updates);

  function applyGithubReadingPreferences(current) {
    const sites = current.translationUrlPattern ?? {};
    const list = value => Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
    const wholeGithub = new Set(['github.com', 'github.com/*', 'https://github.com',
      'https://github.com/', 'https://github.com/*', '*://github.com/*']);
    const generalRule = current.generalRule ?? {};
    const css = list(generalRule['injectedCss.add']);
    const red = 'html[imt-state="dual"]:has(head meta[name="hostname"][content="github.com"]) .immersive-translate-target-wrapper[lang|="zh" i] .immersive-translate-target-inner[data-immersive-translate-translation-element-mark="1"] { color: #d32f2f !important; print-color-adjust: exact; }';
    const compactCss = value => value.replace(/\s+/g, '');
    const hasRed = css.some(rule => typeof rule === 'string' && compactCss(rule).includes(compactCss(red)));

    return {
      ...current,
      isChangedAlwaysTranslatedUrls: true,
      translationUrlPattern: {
        ...sites,
        matches: [...new Set([...list(sites.matches), 'github.com'])],
        excludeMatches: list(sites.excludeMatches).filter(site => !wholeGithub.has(site)),
      },
      generalRule: {
        ...generalRule,
        'injectedCss.add': hasRed ? css : [...css, red],
      },
    };
  }
})().catch(() => console.warn('合并版阅读偏好写入失败，将在下次启动时重试'));
