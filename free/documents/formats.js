import { textDocument } from './text.js';
import { htmlBlob, htmlDocument, mhtmlBody, parseXml, registerMarkup } from './markup.js';

const wordNamespaces = [
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main'
];

function registerWord(doc, add) {
  for (const ns of wordNamespaces) {
    for (const p of doc.getElementsByTagNameNS(ns, 'p')) {
      const chunks = [];
      for (const node of p.getElementsByTagNameNS(ns,'*')) {
        if (['t','br','tab'].includes(node.localName)) {
          let ancestor = node.parentElement;
          while (ancestor && ancestor !== p && !['del','p'].includes(ancestor.localName)) ancestor = ancestor.parentElement;
          if (ancestor === p) chunks.push(node.localName === 't' ? node.textContent : ' ');
        }
      }
      add(chunks.join(''), t => {
        const make = name => doc.createElementNS(ns, 'w:'+name);
        const run = make('r');
        const properties = make('rPr');
        const color = make('color');
        color.setAttributeNS(ns,'w:val','D32F2F');
        properties.append(color);
        const text = make('t');
        text.textContent = t;
        run.append(properties, make('br'), text);
        p.append(run);
      });
    }
  }
}

async function archiveDocument(file, ext, target, add) {
  const zip = await globalThis.JSZip.loadAsync(await file.arrayBuffer());
  const items = Object.values(zip.files).filter(entry=>!entry.dir);
  let expanded = 0;
  for (const entry of items) expanded += entry._data.uncompressedSize;
  if (items.length > 10000 || !Number.isFinite(expanded) || expanded > 160*1024*1024) {
    throw Error('压缩包展开后过大，请拆分文件后重试。');
  }
  const word = ext === 'docx';
  const documents = [];
  const archivePaths = new Set();
  if (word) {
    if (!zip.file('word/document.xml')) throw Error('DOCX 缺少 word/document.xml。');
    for (const entry of items) {
      if (/^word\/(document|(?:header|footer)\d*|endnotes|footnotes)\.xml$/i.test(entry.name)) archivePaths.add(entry.name);
    }
  } else {
    const container = zip.file('META-INF/container.xml');
    if (!container) throw Error('EPUB 缺少 META-INF/container.xml。');
    const containerDoc = parseXml(await container.async('string'));
    for (const rootFile of containerDoc.getElementsByTagNameNS('*','rootfile')) {
      const rootPath = rootFile.getAttribute('full-path');
      const pkg = zip.file(rootPath);
      if (!pkg) throw Error('EPUB 缺少书籍清单。');
      const manifest = parseXml(await pkg.async('string'));
      for (const item of manifest.getElementsByTagNameNS('*','item')) {
        if (item.getAttribute('media-type') !== 'application/xhtml+xml') continue;
        const href = item.getAttribute('href');
        const url = new URL(href, new URL(rootPath,'https://book.invalid/'));
        if (url.origin === 'https://book.invalid') archivePaths.add(decodeURIComponent(url.pathname.slice(1)));
      }
    }
  }
  for (const name of archivePaths) {
    const entry = zip.file(name);
    if (!entry) throw Error('压缩包中缺少文档部件 ' + name);
    const doc = parseXml(await entry.async('string'));
    if (word) registerWord(doc, add);
    else {
      const body = doc.getElementsByTagNameNS('*','body')[0];
      if (body) registerMarkup(body, target, add);
    }
    documents.push({name,doc});
  }
  return {ext, export:async () => {
    for (const {name,doc} of documents) zip.file(name, new XMLSerializer().serializeToString(doc));
    if (!word) zip.file('mimetype','application/epub+zip',{compression:'STORE'});
    return zip.generateAsync({type:'blob', compression:'DEFLATE', mimeType: word
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/epub+zip'});
  }};
}

function joinPdfLine(current, next) {
  if (!current || !next || /\s$/.test(current) || /^\s/.test(next)) return current + next;
  return current + (/^[,.;:!?%)\]]/.test(next) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(current.at(-1) + next[0]) ? '' : ' ') + next;
}

async function pdfDocument(file, target, add) {
  const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  const directory = new URL('../vendor/pdfjs/', import.meta.url);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', directory).href;
  const task = pdfjs.getDocument({
    data:new Uint8Array(await file.arrayBuffer()), isEvalSupported:false, useWasm:false,
    cMapUrl:new URL('cmaps/',directory).href, cMapPacked:true, useWorkerFetch:false,
    standardFontDataUrl:new URL('standard_fonts/',directory).href, disableFontFace:true
  });
  const main = document.createElement('main');
  try {
    const doc = await task.promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const {items} = await p.getTextContent();
      const page = document.createElement('section');
      const label = document.createElement('h2');
      label.textContent = '第 ' + i + ' 页';
      page.append(label);
      main.append(page);
      let line = '';
      const flush = () => {
        if (!line.trim()) return;
        const source = document.createElement('p');
        source.textContent = line;
        page.append(source);
        add(line, text => {
          const translation = document.createElement('span');
          translation.lang = target;
          translation.style.color = '#d32f2f';
          translation.textContent = text;
          source.append(document.createElement('br'),translation);
        });
        line = '';
      };
      for (const item of items) {
        if (typeof item.str !== 'string') continue;
        line = joinPdfLine(line, item.str);
        if (item.hasEOL) flush();
      }
      flush();
      p.cleanup();
    }
  } catch (error) {
    if (error.name === 'PasswordException') throw Error('此 PDF 已加密。请先使用可正常打开的副本。');
    throw error;
  } finally {
    await task.destroy();
  }
  return {ext:'html', export:() => htmlBlob(main.outerHTML)};
}

export async function readDocument(file, target, add) {
  if (file.size > 40 * 1024 * 1024) throw Error('文件超过 40 MB，请拆分后重试。');
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'docx' || ext === 'epub') return archiveDocument(file, ext, target, add);
  if (ext === 'pdf') return pdfDocument(file, target, add);
  if (ext === 'mhtml' || ext === 'mht') return htmlDocument(mhtmlBody(await file.arrayBuffer()),target,add);
  const html = ['html','htm','xhtml'].includes(ext);
  if (!html && !['txt','md','markdown','json','srt','vtt','ass','ssa','lrc'].includes(ext)) throw Error('不支持此文件类型。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = html ? new TextDecoder('windows-1252').decode(bytes.subarray(0,1024)) : '';
  let encoding = /<meta\s[^>]*?charset\s*=\s*["']?([a-z\d._-]+)/i.exec(header)?.[1] || 'utf-8';
  if (bytes[0] === 255 && bytes[1] === 254) encoding = 'utf-16le';
  if (bytes[0] === 254 && bytes[1] === 255) encoding = 'utf-16be';
  if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) encoding = 'utf-8';
  let text;
  try {
    text = new TextDecoder(encoding,{fatal:true}).decode(bytes);
  } catch {
    throw Error('无法识别文本编码，请将文件另存为 UTF-8 后重试。');
  }
  return html ? htmlDocument(text,target,add) : textDocument(text,ext,add);
}
