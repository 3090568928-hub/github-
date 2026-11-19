// Offline GitHub interface localization. dictionary.js supplies the upstream
// page-specific lexicon and DOM exceptions (see COPYING and SOURCE.md).
(() => {
  'use strict';

  const locale = I18N['zh-CN'];
  const config = I18N.conf;
  const siteTypes = {
    'gist.github.com': 'gist',
    'skills.github.com': 'skills',
    'www.githubstatus.com': 'status',
    'education.github.com': 'education',
  };
  if (location.hostname !== 'github.com' && !Object.hasOwn(siteTypes, location.hostname)) return;

  // Upstream handles these React menus separately. Localize their text nodes
  // after rendering, without replacing components or their event handlers.
  const reactiveMenus = ['header.GlobalNav', 'header.GlobalNav [class*="Search-module__"]',
    'qbsearch-input', '#__primerPortalRoot__'];
  const menuSelector = reactiveMenus.join(',');
  const protectedRegions = [
    '[data-geb-owned]', 'head', 'textarea', 'input', '[contenteditable]:not([contenteditable="false"])',
    '.markdown-body', 'article', '[itemprop="about"]', '[data-testid="repository-description"]',
    '.BorderGrid-cell .f4', '.js-comment-body', '#wiki-body', 'pre', 'code', 'kbd', 'samp',
    '.monaco-editor', '.cm-editor', '.blob-code', '.react-code-text',
    '[data-testid="issue-title"]', '[class*="IssueHeader"] [class*="markdown-title"]',
    'strong[itemprop="name"]', 'a[data-hovercard-type="user"]', 'a[data-hovercard-type="repository"]',
    '.f4.my-3', '.f4.tmp-my-3', 'p[class*="SidebarAbout"][class*="description"]',
    '[class*="borderGrid__"] p[class*="description__"]',
  ];
  const labels = ['aria-label', 'title', 'data-confirm', 'data-confirm-text',
    'data-confirm-cancel-text', 'data-visible-text', 'data-content'];
  const originals = new WeakMap();
  const pending = new Set();
  let enabled = false;
  let timer;
  let page;

  function pageType() {
    const {hostname, pathname, search} = location;
    if (siteTypes[hostname]) return siteTypes[hostname];
    const meta = document.querySelector('meta[name="analytics-location"]')?.content || '';
    if (document.body?.classList.contains('session-authentication')) return 'session-authentication';
    if (pathname === '/') return document.body?.classList.contains('logged-in') ? 'dashboard' : 'homepage';
    if (pathname.startsWith('/orgs/') || pathname.startsWith('/organizations/') || meta.includes('/<org-login>')) {
      const match = pathname.match(config.rePagePathOrg);
      return match?.[1] ? 'orgs/' + match[1] : 'orgs';
    }
    if (meta === '/<user-name>' || document.body?.classList.contains('page-profile')) {
      const tab = pathname.endsWith('/stars') ? 'stars' : new URLSearchParams(search).get('tab');
      return tab ? 'page-profile/' + tab : 'page-profile';
    }
    const globalMatch = pathname.match(config.rePagePath);
    const globalRoute = globalMatch && (!pathname[globalMatch[0].length] || pathname[globalMatch[0].length] === '/');
    if (globalRoute && !meta.includes('/<user-name>/<repo-name>')) return globalMatch.slice(1).find(Boolean) || 'public';
    if (/^\/[^/]+\/[^/]+/.test(pathname)) {
      const subpage = pathname.match(config.rePagePathRepo)?.[1];
      return subpage ? 'repository/' + subpage : 'repository';
    }
    return 'public';
  }

  function configure(type) {
    const section = locale[type] || {};
    const common = locale.public;
    const ignored = config.ignoreSelectorPage['*'].filter(selector => !reactiveMenus.includes(selector));
    page = {
      type,
      skip: [...protectedRegions, ...ignored, ...(config.ignoreSelectorPage[type] || [])].join(','),
      exact: {...common.static, ...section.static},
      patterns: [...(section.regexp || []), ...common.regexp],
      titleExact: {...common.title?.static, ...section.title?.static},
      titlePatterns: [...(section.title?.regexp || []), ...(common.title?.regexp || [])],
      selectors: section.selector || [],
      length: config.maxTextNodeLengthPage?.[type] || 500,
      cache: new Map(),
    };
  }

  function lookup(source, surface) {
    const trimmed = source.trim();
    if (!trimmed || trimmed.length > page.length || !/[a-z]/i.test(trimmed)) return source;
    const text = trimmed.replace(/\s+/g, ' ');
    const key = surface + '\n' + text;
    let translated = page.cache.get(key);
    if (translated === undefined) {
      const exact = surface === 'title' ? page.titleExact : page.exact;
      translated = Object.hasOwn(exact, text) ? exact[text] : null;
      if (!translated && surface === 'menu') translated = config.reactGlobalNavLabels?.[text];
      if (typeof translated !== 'string') {
        translated = text;
        for (const [pattern, replacement] of surface === 'title' ? page.titlePatterns : page.patterns) {
          translated = text.replace(pattern, replacement);
          if (translated !== text) break;
        }
      }
      if (page.cache.size >= 3500) page.cache.clear();
      page.cache.set(key, translated);
    }
    return translated === text ? source : source.replace(trimmed, () => translated);
  }

  function update(node, field, surface, restore = false, label) {
    const current = field === 'text' ? node.data : node.getAttribute(field);
    const record = originals.get(node);
    const previous = record?.get(field);
    if (!current) { record?.delete(field); return; }
    const source = previous?.value === current ? previous.source : current;
    const value = restore ? source : label ?? lookup(source, surface);
    if (value !== current) {
      if (field === 'text') node.data = value;
      else node.setAttribute(field, value);
    }
    if (value === source) record?.delete(field);
    else {
      const fields = record || new Map();
      fields.set(field, {source, value});
      if (!record) originals.set(node, fields);
    }
  }

  function visit(node, restore) {
    if (restore) {
      for (const field of originals.get(node)?.keys() || []) update(node, field, '', true);
      return;
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return;
    const surface = element.closest(menuSelector) ? 'menu' : 'page';
    if (node.nodeType === Node.TEXT_NODE) {
      // Some surfaces label a specific native UI control via a CSS selector.
      // Replacing a lone text node preserves its parent's listeners and icons.
      const rule = element.childNodes.length === 1 && page.selectors.find(([s]) => element.matches(s));
      update(node, 'text', surface, false, rule ? rule[1] : undefined);
    }
    else for (const attribute of labels) {
      if (node.hasAttribute(attribute)) update(node, attribute, surface);
    }
  }

  function scan(root, restore = false) {
    const element = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
    if (!element || (!restore && element.closest(page.skip))) return;
    visit(root, restore);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      node => !restore && node.nodeType === Node.ELEMENT_NODE && node.matches(page.skip)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
    while (walker.nextNode()) visit(walker.currentNode, restore);
  }

  function flush() {
    timer = undefined;
    if (!enabled || !document.body) return;
    const type = pageType();
    if (page?.type !== type) { configure(type); pending.clear(); pending.add(document.body); }
    if (document.title) {
      const text = document.querySelector('title')?.firstChild;
      if (text?.nodeType === Node.TEXT_NODE) update(text, 'text', 'title');
    }
    for (const root of pending) {
      if (!root.isConnected) continue;
      let ancestor = root.parentElement;
      while (ancestor && !pending.has(ancestor)) ancestor = ancestor.parentElement;
      if (!ancestor) scan(root);
    }
    pending.clear();
  }

  function queue(root) {
    if (!enabled || !root) return;
    if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.TEXT_NODE) pending.add(root);
    if (timer === undefined) timer = setTimeout(flush, 40);
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(queue);
      else if (record.attributeName !== 'class' || record.target.matches('react-app, react-partial, body')) queue(record.target);
    }
  });
  function setEnabled(value) {
    if (enabled === value) return;
    enabled = value;
    if (enabled) {
      observer.observe(document, {subtree:true, childList:true, characterData:true,
        attributes:true, attributeFilter:[...labels, 'class']});
      queue(document.body || document.documentElement);
    } else {
      observer.disconnect();
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
      if (document.documentElement) scan(document.documentElement, true);
      page = null;
    }
  }
  for (const event of ['turbo:render', 'turbo:load', 'popstate', 'pageshow']) {
    window.addEventListener(event, () => queue(document.body));
  }
  let preferenceChanged = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.localizeGithub) {
      preferenceChanged = true;
      setEnabled(changes.localizeGithub.newValue !== false);
    }
  });
  chrome.storage.local.get({localizeGithub:true}).then(({localizeGithub}) => {
    if (!preferenceChanged) setEnabled(localizeGithub !== false);
  });
})();
