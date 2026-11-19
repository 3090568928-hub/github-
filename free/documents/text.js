const textOutput = (ext, mime, content) => ({
  ext,
  export: () => new Blob([content()], {type: mime + ';charset=utf-8'})
});

function cleanCue(s) {
  return s.replace(/<[^<>]*>/g, '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function escapedCue(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function subtitleBlocks(source, ext, add) {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const blocks = source.split(/\r?\n(?:[ \t]*\r?\n)+/);
  blocks.forEach((block, n) => {
    const lines = block.split(/\r?\n/);
    if (/^(WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0])) return;
    const timing = lines.findIndex(s => /^\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}/.test(s));
    if (timing < 0) return;
    const cue = cleanCue(lines.slice(timing + 1).join(' '));
    add(cue, t => {blocks[n] = lines.join(nl).trimEnd() + nl + escapedCue(t.replace(/\s+/g, ' '));});
  });
  return textOutput(ext, ext === 'vtt' ? 'text/vtt' : 'application/x-subrip', () => blocks.join(nl + nl) + (source.endsWith('\n') ? nl : ''));
}

function ass(lines, add) {
  let events = false;
  let fields = 10;
  lines.forEach((line, i) => {
    if (/^\[.+\]\s*$/.test(line)) {events = /^\[events\]/i.test(line);return;}
    if (!events) return;
    if (/^Format:/i.test(line)) {
      const list = line.slice(line.indexOf(':') + 1).split(',').map(s => s.trim().toLowerCase());
      fields = list.at(-1) === 'text' ? list.length : 0;
    }
    if (!fields || !/^Dialogue:/i.test(line)) return;
    const parts = line.split(',');
    if (parts.length < fields) return;
    const cue = parts.slice(fields - 1).join(',');
    add(cue.replace(/{[^}]*}/g, '').replace(/\\[Nnh]/g, ' '), t => {
      lines[i] = line + '\\N' + t.replace(/[{}\\]/g, '').replace(/\s+/g,' ');
    });
  });
}

function markdown(lines, add) {
  let fence = null;
  let header = lines[0]?.trim() === '---';
  let table = false;
  const separator = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  const originalLines = lines.slice();
  const escapeText = t => t.replace(/\s+/g,' ').replace(/([\\`*_{}\[\]()#+!|<>~-])/g,'\\$1');
  lines.forEach((line, i) => {
    if (header) {if (i && /^(---|\.\.\.)\s*$/.test(line)) header = false;return;}
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = null;
      return;
    }
    if (mark) {fence = mark;return;}
    if (/^(?: {4}|\t)|^\s*(?:<|\[[^\]]+\]:|!\[)/.test(line)) return;
    if (!line.includes('|')) table = false;
    if (line.includes('|') && separator.test(originalLines[i + 1] || '')) table = true;
    if (table) {
      if (separator.test(line)) return;
      const cells = line.split(/(?<!\\)\|/);
      cells.forEach((cell, j) => {
        const text = cell.trim().replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/`[^`]*`/g,'');
        add(text, t => {
          cells[j] = cell.trimEnd() + '　' + escapeText(t) + ' ';
          lines[i] = cells.join('|');
        });
      });
      return;
    }
    const parts = line.match(/^(\s*(?:>\s*)*(?:(?:#{1,6}|[-+*]|\d+[.)])\s+)?)(.*)$/);
    const plain = parts[2].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`[^`]*`/g,'').replace(/[*_~]/g,'');
    add(plain, t => {
      // A translation is text, even when its first characters resemble Markdown.
      lines[i] = line + '　' + escapeText(t);
    });
  });
}

export function textDocument(source, ext, add) {
  if (ext === 'srt' || ext === 'vtt') return subtitleBlocks(source, ext, add);
  if (ext === 'json') {
    const root = {value: JSON.parse(source)};
    const visit = (obj, key) => {
      const v = obj[key];
      if (typeof v === 'string') add(v, t => {obj[key] = t;});
      else if (v && typeof v === 'object') Object.keys(v).forEach(k => visit(v,k));
    };
    visit(root, 'value');
    return textOutput(ext, 'application/json', () => JSON.stringify(root.value, null, 2));
  }
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  if (ext === 'ass' || ext === 'ssa') ass(lines, add);
  else if (ext === 'lrc') {
    lines.forEach((line, i) => {
      const match = /^((?:\[\d+:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/.exec(line);
      if (match) add(match[2].replace(/<\d+:\d{2}(?:[.:]\d{1,3})?>/g, ''), t => {lines[i] = line + ' / ' + t.replace(/\s+/g, ' ');});
    });
  } else if (ext === 'md' || ext === 'markdown') markdown(lines, add);
  else lines.forEach((line, i) => add(line, t => {lines[i] = line + nl + t;}));
  return textOutput(ext,'text/plain',() => lines.join(nl));
}
