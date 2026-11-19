(() => {
  'use strict';
  const defaults = {
    githubAuto: true, autoSites: [], localizeGithub: true, targetLanguage: 'zh-CN',
    selectionTools: true, hoverTranslate: true, inputTranslate: true, videoCaptions: true
  };
  async function request(texts, target) {
    const reply = await chrome.runtime.sendMessage({type: 'translate', texts, target});
    if (!reply || reply.error) throw new Error(reply?.error || '翻译服务暂时未响应');
    if (!Array.isArray(reply.translations) || reply.translations.length !== texts.length ||
        reply.translations.some(t => typeof t !== 'string' || !t.trim())) throw new Error('翻译服务返回了不完整的结果');
    return reply.translations;
  }
  async function translate(texts, target) {
    if (texts.length<=64 && texts.reduce((n,t)=>n+t.length,0)<=65536) return request(texts,target);
    const output=texts.map(()=>''), batch=[];
    let chars=0;
    async function flush() {
      if (!batch.length) return;
      const answers=await request(batch.map(part=>part.text),target);
      batch.forEach((part,i)=>{output[part.index]+=answers[i];});
      batch.length=0; chars=0;
    }
    for (const [index,value] of texts.entries()) {
      let pos=0;
      while(pos<value.length) {
        let stop=Math.min(value.length,pos+16000);
        if(stop<value.length && /[\uD800-\uDBFF]/.test(value[stop-1])) stop--;
        const text=value.slice(pos,stop);
        if (chars+text.length>65536 || batch.length===64) await flush();
        batch.push({index,text}); chars+=text.length; pos=stop;
      }
    }
    await flush();
    return output;
  }
  function needsTranslation(text, target) {
    const english = (text.match(/[a-z]/gi) || []).length;
    const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
    return target === 'en' ? chinese > 0 : english >= 2 && (chinese === 0 || english > chinese * 4);
  }
  globalThis.geb = {defaults, settings: {...defaults}, translate, needsTranslation};
})();
