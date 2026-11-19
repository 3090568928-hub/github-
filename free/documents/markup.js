const blocks = new Set('article aside blockquote body caption dd details div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header li main nav ol p section summary table tbody td th thead tr ul'.split(' '));
const inline = new Set('a abbr b br cite code del em i kbd mark q s samp small span strong sub sup time u var'.split(' '));
const skip = new Set('audio canvas embed form iframe img input link math meta noscript object script style svg template title video'.split(' '));

export function parseXml(raw) {
  if (/<!ENTITY\s/i.test(raw)) throw Error('文档包含不支持的 XML 实体。');
  const doc = new DOMParser().parseFromString(raw, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw Error('文件中的 XML 无法解析。');
  return doc;
}

// Only construct static formatting. Template contents are inert; remote assets never enter the extension document.
function staticHtml(source) {
  const template = document.createElement('template');
  template.innerHTML = source;
  const fragment = document.createDocumentFragment();
  function copy(node, dest) {
    if (node.nodeType === Node.TEXT_NODE) {dest.append(node.cloneNode());return;}
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.localName.toLowerCase();
    if (skip.has(tag) || node.hidden || node.getAttribute('aria-hidden') === 'true') return;
    let target = dest;
    if (blocks.has(tag) || inline.has(tag) || ['pre','hr'].includes(tag)) {
      target = document.createElement(tag);
      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        if (/^(?:https?:\/\/|#)/i.test(href)) {
          target.setAttribute('href', href);
          target.setAttribute('rel','noreferrer noopener');
        }
      }
      for (const key of ['colspan','rowspan']) {
        const v = node.getAttribute(key);
        if ((tag === 'td' || tag === 'th') && v && /^\d{1,3}$/.test(v)) target.setAttribute(key, v);
      }
      dest.append(target);
    }
    for (const child of node.childNodes) copy(child, target);
  }
  for (const child of template.content.childNodes) copy(child, fragment);
  return fragment;
}

function leafText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.data;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.localName.toLowerCase();
  if (tag === 'br') return ' ';
  if (skip.has(tag) || tag === 'pre' || tag === 'code' || tag === 'rt') return '';
  return Array.from(node.childNodes, leafText).join('');
}

export function registerMarkup(parent, target, add) {
  let run = [];
  function flush() {
    if (!run.length) return;
    const last = run.at(-1);
    const text = run.map(leafText).join('').replace(/\s+/g, ' ');
    add(text, translation => {
      const owner = last.ownerDocument;
      const ns = parent.namespaceURI || 'http://www.w3.org/1999/xhtml';
      const note = owner.createElementNS(ns, 'span');
      note.setAttribute('lang', target);
      note.setAttribute('style', 'color:#d32f2f');
      note.textContent = translation;
      parent.insertBefore(note, last.nextSibling);
      parent.insertBefore(owner.createElementNS(ns,'br'), note);
    });
    run = [];
  }
  for (const node of parent.childNodes) {
    const tag = node.nodeType === Node.ELEMENT_NODE ? node.localName.toLowerCase() : '';
    if (tag && (blocks.has(tag) || tag === 'pre' || tag === 'hr' || skip.has(tag))) {
      flush();
      if (blocks.has(tag)) registerMarkup(node, target, add);
    } else run.push(node);
  }
  flush();
}

export function htmlDocument(source, target, add) {
  const body = document.createElement('main');
  body.append(staticHtml(source));
  registerMarkup(body, target, add);
  return { ext:'html', export:() => htmlBlob(body.outerHTML) };
}

export function htmlBlob(markup) {
  return new Blob(['<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>双语文档</title></head><body>',markup,'</body></html>'],{type:'text/html;charset=utf-8'});
}

function splitPart(part) {
  const topEnd = part.indexOf('\n\n');
  if (topEnd < 0) return {};
  const fields = {};
  const header = part.slice(0,topEnd).replace(/\n[ \t]+/g,' ');
  for (const line of header.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields[line.slice(0,colon).toLowerCase().trim()] = line.slice(colon+1).trim();
  }
  return {fields, body:part.slice(topEnd+2)};
}

export function mhtmlBody(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i=0; i<bytes.length; i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
  function find(part, depth) {
    if (depth > 12) throw Error('MHTML 的 MIME 嵌套层数过多。');
    const {fields, body} = splitPart(part);
    if (!fields) return null;
    const type = fields['content-type'] || '';
    if (/^multipart\//i.test(type)) {
      const m = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
      if (!m) return null;
      const delimiter = '--' + (m[1] || m[2]);
      const parts = ('\n'+body).split('\n' + delimiter);
      for (const nested of parts.slice(1)) {
        if (nested.startsWith('--')) break;
        const found = find(nested.replace(/^[ \t]*\n/,''), depth+1);
        if (found !== null) return found;
      }
    } else if (/^(?:text\/html|application\/xhtml\+xml)\b/i.test(type)) {
      const transfer = (fields['content-transfer-encoding'] || '').toLowerCase();
      let raw = body;
      if (transfer === 'base64') raw = atob(body.replace(/\s/g,''));
      if (transfer === 'quoted-printable') raw = body.replace(/=\n/g,'').replace(/=([0-9a-f]{2})/ig,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
      const cs = /charset\s*=\s*"?([\w.-]+)/i.exec(type)?.[1] || 'utf-8';
      return new TextDecoder(cs).decode(Uint8Array.from(raw, c=>c.charCodeAt(0)));
    }
    return null;
  }
  const html = find(binary.replace(/\r\n/g,'\n'), 0);
  if (html === null) throw Error('MHTML 中没有可读取的 HTML 页面。');
  return html;
}
