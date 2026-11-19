(() => {
  'use strict';
  const api = globalThis.geb;
  let host, shadow, seq = 0, hoverTimer, hoverBlock, inputJob = 0;
  const bubbleStyle = ':host{all:initial;position:fixed!important;z-index:2147483647!important}section{box-sizing:border-box;max-width:min(360px,90vw);max-height:38vh;overflow:auto;padding:9px 12px;background:#202832;color:white;border:1px solid #596674;border-radius:7px;font:14px/1.55 system-ui,sans-serif;box-shadow:0 3px 12px #0003;white-space:pre-wrap;text-align:start}button{font:inherit;color:white;background:transparent;border:0;cursor:pointer;padding:0 3px}';
  function close() { seq++; host?.remove(); host = shadow = null; }
  function show(text, point, onClick) {
    host?.remove();
    host = document.createElement('div');
    host.dataset.gebOwned = 'bubble';
    host.translate = false;
    shadow = host.attachShadow({mode:'closed'});
    const style = document.createElement('style');
    style.textContent = bubbleStyle;
    const box = document.createElement('section');
    if (onClick) {
      const button = document.createElement('button');
      button.textContent = text;
      button.addEventListener('pointerdown', e=>e.preventDefault());
      button.addEventListener('click',onClick,{once:true});
      box.append(button);
    } else { box.setAttribute('role','status'); box.textContent = text; }
    shadow.append(style,box);
    document.documentElement.append(host);
    const size = host.getBoundingClientRect();
    host.style.left = Math.max(4,Math.min(point.x, innerWidth-size.width-8)) + 'px';
    host.style.top = Math.max(4,Math.min(point.y+8, innerHeight-size.height-6)) + 'px';
  }
  function direction(text) { return /[\u3400-\u9fff]/.test(text) && !api.needsTranslation(text,'zh-CN') ? 'en' : 'zh-CN'; }
  async function translateAt(value,point) {
    const text = value.trim();
    if (!text) return;
    const id = ++seq;
    show('翻译中…',point);
    try {
      const [translated] = await api.translate([text],direction(text));
      if (seq === id) show(translated,point);
    } catch (error) { if (seq === id) show(error.message,point); }
  }
  function pointFor(el) {
    const r = el.getBoundingClientRect();
    return {x:Math.max(r.left,8), y:Math.min(r.bottom,innerHeight-55)};
  }
  function selected() {
    const s = getSelection();
    if (!s?.rangeCount || s.isCollapsed) return null;
    const range = s.getRangeAt(0);
    const parent = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (parent?.closest('input,textarea,[contenteditable],[data-geb-owned]')) return null;
    const rect = range.getBoundingClientRect();
    return {text:s.toString().trim(),point:{x:rect.left,y:rect.bottom}};
  }
  document.addEventListener('pointerup',e=>{
    if (!api.settings.selectionTools || e.button!==0 || e.target===host) return;
    const s = selected();
    if (!s?.text) { if (host) close(); return; }
    ++seq;
    show('翻译选中文字',s.point,()=>translateAt(s.text,s.point));
  });
  document.addEventListener('pointerdown',e=>{ if (host && e.target!==host) close(); },true);
  const editable = el => {
    if (!(el instanceof HTMLElement) || el.closest('[data-geb-owned]')) return null;
    const field = el.closest('textarea,input,[contenteditable]:not([contenteditable="false"])');
    if (!field || field.disabled || field.readOnly) return null;
    if (field instanceof HTMLInputElement && !['text','search'].includes(field.type)) return null;
    if (/(?:password|one-time-code|cc-|credit.?card|secret|token|api.?key|验证码|密钥|密码)/i.test([field.autocomplete,field.id,field.getAttribute('name'),field.getAttribute('aria-label'),field.getAttribute('placeholder')].join(' '))) return null;
    return field;
  };
  const getValue=field=>'value' in field ? field.value : field.innerText;
  async function translateInput(field,stripSpaces=false) {
    if (!field || !api.settings.inputTranslate) return;
    const original = getValue(field), hasValue = 'value' in field;
    const selection = getSelection();
    const savedRange = !hasValue && selection?.rangeCount && field.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.getRangeAt(0).cloneRange() : null;
    const subset = hasValue && field.selectionEnd > field.selectionStart;
    const start = subset ? field.selectionStart : 0, end = subset ? field.selectionEnd : original.length;
    const fragment = hasValue ? original.slice(start,end) : (savedRange && !savedRange.collapsed ? savedRange.toString() : original);
    const text = stripSpaces ? fragment.replace(/ {3}$/,'') : fragment;
    if (!text.trim()) return;
    const job = ++inputJob;
    try {
      const [result] = await api.translate([text],direction(text));
      if (inputJob!==job || !field.isConnected || document.activeElement!==field || getValue(field)!==original) return;
      if (hasValue) {
        const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set;
        setter.call(field,original.slice(0,start)+result+original.slice(end));
        field.setSelectionRange(start+result.length,start+result.length);
        field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:result}));
      } else {
        const range=savedRange || document.createRange();
        if (!savedRange || savedRange.collapsed) range.selectNodeContents(field);
        selection.removeAllRanges(); selection.addRange(range);
        document.execCommand('insertText',false,result);
      }
    } catch (error) { show(error.message,pointFor(field)); }
  }
  document.addEventListener('input',e=>{
    if (!e.isTrusted || e.isComposing || !api.settings.inputTranslate || e.inputType!=='insertText' || e.data!==' ') return;
    const f=editable(e.target);
    if (f && / {3}$/.test(getValue(f))) translateInput(f,true);
  });
  function scheduleHover(el,point) {
    const block=el?.closest?.('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,dd,figcaption');
    if (!block || block.closest('pre,code,textarea,input,[contenteditable],[data-geb-owned]') || !api.settings.hoverTranslate) return;
    if (block===hoverBlock) return;
    hoverBlock=block;
    clearTimeout(hoverTimer);
    hoverTimer=setTimeout(()=>{
      const copy=block.cloneNode(true);
      copy.querySelectorAll('[data-geb-owned]').forEach(n=>n.remove());
      translateAt(copy.textContent,point);
    },400);
  }
  let pointer, lastInputField, lastInputTime = -Infinity;
  function inputShortcut(field) {
    if (!field || !api.settings.inputTranslate) return false;
    const now = performance.now();
    if (lastInputField !== field || now - lastInputTime > 350) {
      lastInputField = field;
      lastInputTime = now;
      translateInput(field);
    }
    return true;
  }
  document.addEventListener('pointermove',e=>{
    pointer={x:e.clientX,y:e.clientY};
    if(e.ctrlKey) scheduleHover(e.target,pointer);
  },{passive:true});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape') close();
    if(e.key==='Control' && pointer && !e.repeat) scheduleHover(document.elementFromPoint(pointer.x,pointer.y),pointer);
    if(e.isTrusted && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.repeat && !e.isComposing &&
       e.code==='KeyI' && api.settings.inputTranslate) {
      const field=editable(e.target);
      if(field) chrome.runtime.sendMessage({type:'input-key-binding'}).then(binding=>{
        if(binding==='Alt+I' && field===document.activeElement && document.hasFocus()) inputShortcut(field);
      }).catch(()=>{});
    }
  });
  document.addEventListener('keyup',e=>{
    if(e.key==='Control'){clearTimeout(hoverTimer);hoverBlock=null;}
  });
  chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
    if(sender.id!==chrome.runtime.id) return;
    if(msg?.type==='translate-input') reply({ok:inputShortcut(editable(document.activeElement))});
    if(msg?.type==='translate-selection'){
      const s=selected(), text=msg.text || s?.text;
      if(text) translateAt(text,s?.point || {x:24,y:40});
      reply({ok:Boolean(text)});
    }
  });
})();
