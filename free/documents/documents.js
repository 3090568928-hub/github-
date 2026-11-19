import { readDocument } from './formats.js';

const el = id => document.getElementById(id);
const fileInput = el('file');
const targetInput = el('target');
const status = el('status');
const download = el('download');
let generation = 0;
let downloadUrl;

function reset(message = '') {
  generation++;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
  download.removeAttribute('href');
  download.hidden = true;
  el('preview').hidden = true;
  el('rows').replaceChildren();
  el('cancel').hidden = true;
  el('start').disabled = false;
  status.textContent = message;
}

fileInput.addEventListener('change', () => reset());
targetInput.addEventListener('change', () => reset());
el('cancel').addEventListener('click', () => reset('已取消翻译。'));

function splitLongText(text) {
  const pieces = [];
  while (text.length > 15000) {
    let boundary = Math.max(text.lastIndexOf(' ',15000),text.lastIndexOf('\n',15000),text.lastIndexOf('。',15000));
    if (boundary < 9000) boundary = 15000;
    if (text.charCodeAt(boundary) >= 0xd800 && text.charCodeAt(boundary) <= 0xdbff) boundary--;
    pieces.push(text.slice(0,boundary+1));
    text = text.slice(boundary+1);
  }
  if (text) pieces.push(text);
  return pieces;
}

async function translate(originals, target, current) {
  const grouped = originals.map(splitLongText);
  const texts = [...new Set(grouped.flat().map(s=>s.trim()).filter(Boolean))];
  const result = new Map();
  let index = 0;
  while (index < texts.length) {
    if (current !== generation) throw Error('已取消翻译。');
    const batch = [];
    let size = 0;
    while (index < texts.length && batch.length < 12 && size + texts[index].length <= 60000) {
      batch.push(texts[index]);
      size += texts[index++].length;
    }
    const answer = await chrome.runtime.sendMessage({ type: 'translate', texts: batch, target });
    if (current !== generation) throw Error('已取消翻译。');
    if (answer?.error) throw Error(answer.error);
    if (answer?.translations?.length !== batch.length || !answer.translations.every(t => typeof t === 'string' && t.trim())) {
      throw Error('翻译服务返回了不完整的结果，请重试。');
    }
    batch.forEach((text, i) => result.set(text, answer.translations[i].trim()));
    status.textContent = `已翻译 ${index} / ${texts.length} 个不同片段。`;
  }
  return new Map(originals.map((source,i)=>[source,grouped[i].map(piece=>result.get(piece.trim()) || '').join(target === 'en' ? ' ' : '')]));
}

document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault();
  reset();
  const current = generation;
  const file = fileInput.files[0];
  const target = targetInput.value;
  if (!file) return;
  el('start').disabled = true;
  el('cancel').hidden = false;
  try {
    status.textContent = '正在读取文件…';
    const entries = [];
    const add = (source, write) => {
      const text = source.trim();
      if (/\p{L}/u.test(text)) entries.push({text, write});
    };
    const doc = await readDocument(file, target, add);
    if (generation !== current) return;
    if (!entries.length) throw Error('没有找到可翻译的文字。扫描图片 PDF 需要先提取文字。');
    const texts = [...new Set(entries.map(item => item.text))];
    const translated = await translate(texts, target, current);
    if (generation !== current) return;
    for (const entry of entries) entry.write(translated.get(entry.text));
    const blob = await doc.export();
    if (generation !== current) return;
    downloadUrl = URL.createObjectURL(blob);
    download.href = downloadUrl;
    download.download = file.name.replace(/\.[^.]+$/, '') + '-' + target + (doc.ext === 'json' ? '-译文.' : '-双语.') + doc.ext;
    download.hidden = false;
    for (const text of texts.slice(0, 24)) {
      const original = document.createElement('p');
      const translation = document.createElement('p');
      original.textContent = text;
      translation.textContent = translated.get(text);
      translation.className = 'translation';
      el('rows').append(original, translation);
    }
    el('preview').hidden = false;
    status.textContent = `已生成 ${doc.ext.toUpperCase()} 文件，共处理 ${entries.length} 个片段。` +
      (texts.length > 24 ? '下方预览前 24 个不同片段。' : '');
  } catch (error) {
    if (generation === current) status.textContent = '文档翻译失败。' + error.message;
  } finally {
    if (generation === current) {
      el('start').disabled = false;
      el('cancel').hidden = true;
    }
  }
});
