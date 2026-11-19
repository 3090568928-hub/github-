(() => {
  'use strict';
  const api = globalThis.geb;
  const github = location.hostname === 'github.com';
  const blocks = 'p,h1,h2,h3,h4,h5,h6,li,td,th,dt,dd,figcaption,blockquote,summary';
  const containers = 'div,main,article,section,body';
  const boundaries = blocks + ',' + containers;
  const about = '[itemprop="about"],[data-testid="repository-description"],.BorderGrid-cell .f4,p[class*="SidebarAbout"][class*="description"],[class*="borderGrid__"] p[class*="description__"]';
  const githubProse = '.markdown-body,article,.js-comment-body,#wiki-body,' + about;
  const avoid = '[data-geb-owned],.immersive-translate-target-wrapper,.notranslate,[translate="no"],[hidden],[aria-hidden="true"],pre,code,kbd,samp,script,style,noscript,svg,math,nav,button,form,textarea,input,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-testid="blob-viewer-code-area"]';
  let observed = new WeakSet();
  const states = new WeakMap();
  const pending = new Set();
  let active = false, manual = null, epoch = 0, timer, busy = false, lastError = '', pageUrl = location.href;
  let observer;
  const viewport = new IntersectionObserver(entries => {
    if (!active) return;
    for (const item of entries) if (item.isIntersecting) {
      viewport.unobserve(item.target);
      observed.delete(item.target);
      enqueue(item.target);
    }
  }, {rootMargin: '500px 0px'});

  function eligible(el) {
    return el?.isConnected && !el.closest(avoid) && (!github || el.closest(githubProse));
  }
  function source(el,literals=[]) {
    const parts = [];
    const inlineNodes = new Set();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode, parent = n.parentElement;
      const nearest = parent?.closest(boundaries);
      if (!parent || (nearest!==el && !(el.matches(about) && nearest?.contains(el)))) continue;
      const code=parent.closest('code,kbd,samp');
      if (code && !code.parentElement.closest(avoid)) {
        if(!inlineNodes.has(code)) {
          inlineNodes.add(code);
          literals.push(code.textContent);
          parts.push('〔'+literals.length+'〕');
        }
      } else if (!parent.closest(avoid)) parts.push(n.data);
    }
    return parts.join('').replace(/\s+/g,' ').trim();
  }
  function watch(el) {
    if (!eligible(el)) return;
    if (el.matches(containers) && ![...el.childNodes].some(n=>n.nodeType===3 ? /\S/.test(n.data) :
        n.nodeType===1 && !n.matches(boundaries+','+avoid) && n.textContent.trim())) return;
    if (!observed.has(el)) {
      observed.add(el);
      viewport.observe(el);
    } else if (el.getBoundingClientRect().top < innerHeight + 500 && el.getBoundingClientRect().bottom > -500) enqueue(el);
  }
  function scan(root) {
    if (!active || !root || root.closest?.(avoid)) return;
    if (root.matches?.(boundaries)) watch(root);
    const selector = github ? boundaries + ',' + about : boundaries;
    root.querySelectorAll?.(selector).forEach(watch);
  }
  function enqueue(el) {
    if (!active || !eligible(el)) return;
    pending.add(el);
    if (!busy && !timer) timer = setTimeout(drain, 70);
  }
  function clearCopy(el) {
    const state = states.get(el);
    if (state?.copy) state.copy.remove();
    states.delete(el);
  }
  async function drain() {
    timer = null;
    if (busy || !active) return;
    busy = true;
    const current = epoch, target = api.settings.targetLanguage;
    try {
      while (active && epoch === current && pending.size) {
        const items = [], texts = [];
        for (const el of pending) {
          pending.delete(el);
          if (!eligible(el)) continue;
          const literals=[],text = source(el,literals), existing = states.get(el);
          const signature=JSON.stringify([text,literals]);
          if (existing?.signature === signature && existing.target === target && existing.copy?.isConnected) continue;
          if (existing) clearCopy(el);
          if (!api.needsTranslation(text,target)) continue;
          items.push({el,text,literals,signature});
          texts.push(text);
          if (items.length === 12) break;
        }
        if (!items.length) continue;
        let results;
        try { results = await api.translate(texts, target); }
        catch (error) {
          if (epoch === current) lastError = error.message;
          // Avoid continuously resending paragraphs that failed in this view.
          break;
        }
        if (!active || current !== epoch) break;
        lastError = '';
        items.forEach(({el,literals,signature}, i) => {
          const latest=[];
          if (!eligible(el) || JSON.stringify([source(el,latest),latest])!==signature) return;
          const copy = document.createElement('span');
          copy.dataset.gebOwned = 'translation';
          copy.className = github && target === 'zh-CN' ? 'geb-translation geb-github-zh' : 'geb-translation';
          copy.lang = target;
          copy.translate = false;
          copy.textContent = results[i].replace(/[〔【]\s*(\d+)\s*[〕】]/g,(token,index)=>literals[Number(index)-1]??token);
          const childList = [...el.children].find(n => n.matches(boundaries+',ul,ol'));
          el.insertBefore(copy,childList || null);
          states.set(el,{signature,target,copy});
        });
      }
    } finally {
      busy = false;
      if (active && pending.size && (!lastError || epoch !== current)) timer = setTimeout(drain, 150);
    }
  }
  function setActive(value, force = false) {
    if (value === active && !force) return;
    active = value;
    epoch++;
    pending.clear();
    lastError = '';
    viewport.disconnect();
    observed = new WeakSet();
    clearTimeout(timer); timer = null;
    document.querySelectorAll('[data-geb-owned="translation"]').forEach(n => n.remove());
    if (active) scan(document.body);
  }
  function automatic() {
    return github ? api.settings.githubAuto : api.settings.autoSites.includes(location.hostname);
  }
  function sync() { setActive(manual ?? automatic()); }
  function navigation() {
    if (location.href !== pageUrl) { pageUrl = location.href; manual = null; setActive(automatic(), true); }
  }
  function changed(records) {
    navigation();
    if (!active) return;
    const scanRoots = new Set(), dirty = new Set();
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!target || target.closest(avoid)) continue;
      if (record.type === 'childList' && [...record.addedNodes,...record.removedNodes].every(n=>n.nodeType===1&&n.hasAttribute('data-geb-owned'))) continue;
      const nearest = target.closest(boundaries);
      if (nearest) dirty.add(nearest);
      for (const n of record.addedNodes) if (n.nodeType === 1 && !n.matches(avoid)) scanRoots.add(n);
    }
    for (const root of scanRoots) scan(root);
    for (const el of dirty) watch(el);
  }
  const ready = chrome.storage.local.get(api.defaults).then(settings => {
    Object.assign(api.settings,settings);
    observer = new MutationObserver(changed);
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});
    sync();
  });
  api.ready = ready;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key,entry] of Object.entries(changes)) if (key in api.defaults) api.settings[key] = entry.newValue ?? api.defaults[key];
    if ('githubAuto' in changes || 'autoSites' in changes) {manual = null; sync();}
    if ('targetLanguage' in changes && active) setActive(true,true);
  });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !['page-state','toggle-page','retry-page'].includes(msg?.type)) return;
    ready.then(() => {
      if (msg.type === 'toggle-page') { manual = !active; setActive(manual); }
      if (msg.type === 'retry-page') { manual = true; setActive(true,true); }
      reply({active,translated:document.querySelectorAll('[data-geb-owned="translation"]').length,error:lastError,host:location.hostname});
    }).catch(error=>reply({error:error.message}));
    return true;
  });
  addEventListener('popstate',navigation);
  document.addEventListener('turbo:load',navigation);
})();
