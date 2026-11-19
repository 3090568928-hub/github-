'use strict';
const api = globalThis.geb;
const byId = id=>document.getElementById(id);
const checkIds = ['localizeGithub','selectionTools','hoverTranslate','inputTranslate','videoCaptions'];
let settings, tab, host, active = false, poll, request = 0;
const side = new URLSearchParams(location.search).has('side');
if (side) { document.body.classList.add('side'); byId('side').hidden = true; }
async function inspect() {
  const id = ++request;
  const [current] = await chrome.tabs.query({active:true,currentWindow:true});
  let page;
  if(current?.id!=null) {
    try { page=await chrome.tabs.sendMessage(current.id,{type:'page-state'},{frameId:0}); } catch {}
  }
  if(id!==request) return;
  tab=current;
  host=page?.host;
  active=Boolean(page?.active);
  byId('toggle').disabled=!host;
  byId('always').disabled=!host;
  byId('toggle').textContent=active?'显示原文':'翻译此页';
  byId('always').checked=host==='github.com'?settings.githubAuto:settings.autoSites.includes(host);
  byId('always-label').textContent=host?'始终翻译 '+host:'始终翻译此站点';
  byId('state').textContent=page?.error || (host ? (active && page.translated ? '已翻译 '+page.translated+' 段' : '') : '当前页面不支持网页翻译');
  byId('retry').hidden=!page?.error;
}
async function action(type) {
  if(tab?.id==null) return;
  try { await chrome.tabs.sendMessage(tab.id,{type},{frameId:0}); await inspect(); }
  catch { byId('state').textContent='请刷新网页后重试'; }
}
async function start() {
  settings=await chrome.storage.local.get(api.defaults);
  byId('language').value=settings.targetLanguage;
  for(const k of checkIds) {
    byId(k).checked=settings[k];
    byId(k).addEventListener('change',()=>chrome.storage.local.set({[k]:byId(k).checked}));
  }
  byId('language').addEventListener('change',()=>chrome.storage.local.set({targetLanguage:byId('language').value}));
  byId('always').addEventListener('change',async()=>{
    if(!host) return;
    if(host==='github.com') await chrome.storage.local.set({githubAuto:byId('always').checked});
    else {
      const {autoSites}=await chrome.storage.local.get({autoSites:[]});
      const next=new Set(autoSites);
      if(byId('always').checked) next.add(host); else next.delete(host);
      await chrome.storage.local.set({autoSites:[...next]});
    }
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local') return;
    for(const [k,v] of Object.entries(changes)) if(k in api.defaults) settings[k]=v.newValue??api.defaults[k];
    for(const k of checkIds) byId(k).checked=settings[k];
    byId('language').value=settings.targetLanguage;
    inspect();
  });
  byId('toggle').onclick=()=>action('toggle-page');
  byId('retry').onclick=()=>action('retry-page');
  byId('side').onclick=()=>{ if(tab?.windowId!=null) chrome.sidePanel.open({windowId:tab.windowId}).then(()=>window.close()).catch(()=>{byId('state').textContent='当前浏览器无法打开侧栏';}); };
  byId('translate-text').onclick=async()=>{
    const text=byId('source').value.trim(),button=byId('translate-text');
    if(!text) {byId('source').focus();return;}
    button.disabled=true;byId('result').textContent='翻译中…';
    try{const [translated]=await api.translate([text],byId('text-language').value);byId('result').textContent=translated;}
    catch(error){byId('result').textContent=error.message;}
    finally{button.disabled=false;}
  };
  await inspect();
  poll=setInterval(()=>{if(!document.hidden)inspect().catch(()=>{});},1800);
}
addEventListener('pagehide',()=>clearInterval(poll));
start().catch(error=>{byId('state').textContent=error.message;});
