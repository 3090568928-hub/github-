(() => {
  'use strict';
  const videos = new Map();
  const cues = new Map();
  const rendered = new Map();
  const youtube = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(location.hostname);
  const captionBox = '.ytp-caption-window-container .captions-text';
  let enabled = false;
  let target = 'zh-CN';
  const viewport = new IntersectionObserver(entries => {
    for (const entry of entries) syncVideo(entry.target);
    if (enabled && youtube) document.querySelectorAll(captionBox).forEach(syncBox);
  });

  function visible(video) {
    if (document.pictureInPictureElement === video) return true;
    if (!video.isConnected || document.hidden) return false;
    const rect = video.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth && getComputedStyle(video).visibility === 'visible';
  }

  function forgetCue(cue) {
    const state = cues.get(cue);
    if (state.written && cue.text === state.written) cue.text = state.source;
    cues.delete(cue);
  }

  async function translateCue(video, track, cue) {
    const existing = cues.get(cue);
    if (existing && (cue.text === existing.source || cue.text === existing.written)) return;
    const text = cue.getCueAsHTML?.().textContent?.trim() || cue.text?.trim();
    if (!text || !geb.needsTranslation(text, target)) return;
    const state = {video, track, source:cue.text, written:null};
    cues.set(cue, state);
    try {
      const [value] = await geb.translate([text], target);
      if (cues.get(cue) !== state || !enabled || !visible(video) || track.mode !== 'showing' ||
          cue.text !== state.source || !Array.from(track.activeCues || []).includes(cue)) return;
      if (value.trim() === text) return;
      // Keep WebVTT positioning, styling, and timecodes. Escape the service's
      // literal text before appending it to WebVTT's own markup language.
      const escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      state.written = state.source + '\n' + escaped;
      cue.text = state.written;
    } catch {
      // Keep the readable source on failure. A later visit to the cue can retry.
    }
  }

  function syncVideo(video) {
    const tracks = videos.get(video);
    if (!tracks) return;
    const available = new Set(Array.from(video.textTracks)
      .filter(t => t.kind === 'subtitles' || t.kind === 'captions'));
    const active = new Set();
    for (const [track, refresh] of tracks) {
      if (!available.has(track)) {
        track.removeEventListener('cuechange', refresh);
        tracks.delete(track);
      }
    }
    for (const track of available) {
      if (!tracks.has(track)) {
        const refresh = () => syncVideo(video);
        track.addEventListener('cuechange', refresh);
        tracks.set(track, refresh);
      }
      if (!enabled || !visible(video) || track.mode !== 'showing') continue;
      for (const cue of track.activeCues || []) {
        if (typeof cue.text !== 'string') continue;
        active.add(cue);
        translateCue(video, track, cue);
      }
    }
    for (const [cue, state] of cues) if (state.video === video && !active.has(cue)) forgetCue(cue);
  }

  function refreshVideo(event) {
    const video = event.currentTarget instanceof HTMLVideoElement ? event.currentTarget :
      [...videos.keys()].find(v => v.textTracks === event.currentTarget);
    if (video) syncVideo(video);
  }
  function attach(video) {
    if (videos.has(video)) return;
    videos.set(video, new Map());
    viewport.observe(video);
    for (const type of ['change', 'addtrack', 'removetrack']) video.textTracks.addEventListener(type, refreshVideo);
    for (const type of ['loadedmetadata', 'play', 'seeked', 'enterpictureinpicture']) video.addEventListener(type, refreshVideo);
    syncVideo(video);
  }
  function detach(video) {
    viewport.unobserve(video);
    for (const [track, update] of videos.get(video)) track.removeEventListener('cuechange', update);
    for (const type of ['change', 'addtrack', 'removetrack']) video.textTracks.removeEventListener(type, refreshVideo);
    for (const type of ['loadedmetadata', 'play', 'seeked', 'enterpictureinpicture']) video.removeEventListener(type, refreshVideo);
    for (const [cue, state] of cues) if (state.video === video) forgetCue(cue);
    videos.delete(video);
  }

  function clearBox(box) {
    rendered.get(box)?.node?.remove();
    rendered.delete(box);
  }
  async function syncBox(box) {
    const video = box.closest('.html5-video-player')?.querySelector('video');
    if (!video || !visible(video) || !box.getClientRects().length) { clearBox(box); return; }
    const text = [...box.querySelectorAll('.ytp-caption-segment')].map(s => s.textContent).join(' ').trim();
    const previous = rendered.get(box);
    if (previous?.text === text && (!previous.node || previous.node.isConnected)) return;
    clearBox(box);
    if (!geb.needsTranslation(text, target)) return;
    const state = {text, node:null};
    rendered.set(box, state);
    try {
      const [value] = await geb.translate([text], target);
      if (rendered.get(box) !== state || !enabled || !visible(video) || !box.isConnected || value.trim() === text) return;
      const node = document.createElement('span');
      node.dataset.gebOwned = '';
      node.lang = target;
      node.style.cssText = 'display:block;line-height:1.3;color:white;background:rgba(0,0,0,.75)';
      node.textContent = value;
      state.node = node;
      box.append(node);
    } catch { /* The player keeps displaying its original subtitle. */ }
  }

  const observer = new MutationObserver(records => {
    const boxes = new Set();
    let removed = false;
    for (const record of records) {
      if (record.removedNodes.length) removed = true;
      if (youtube) {
        const base = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        const box = base?.closest(captionBox);
        if (box) boxes.add(box);
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE || node.hasAttribute('data-geb-owned')) continue;
        if (node.matches('video')) attach(node);
        node.querySelectorAll('video').forEach(attach);
        if (youtube) {
          if (node.matches(captionBox)) boxes.add(node);
          node.querySelectorAll(captionBox).forEach(el => boxes.add(el));
        }
      }
    }
    if (removed) {
      for (const video of videos.keys()) if (!video.isConnected) detach(video);
      for (const box of rendered.keys()) if (!box.isConnected) clearBox(box);
    }
    boxes.forEach(syncBox);
  });
  function refresh() {
    if (!enabled) return;
    document.querySelectorAll('video').forEach(v => videos.has(v) ? syncVideo(v) : attach(v));
    if (youtube) document.querySelectorAll(captionBox).forEach(syncBox);
  }

  function configure(settings) {
    const next = settings.videoCaptions !== false;
    const language = settings.targetLanguage || 'zh-CN';
    if (next === enabled && language === target) return;
    observer.disconnect();
    for (const video of videos.keys()) detach(video);
    for (const box of rendered.keys()) clearBox(box);
    target = language;
    enabled = next;
    if (enabled) {
      observer.observe(document, {subtree:true, childList:true, characterData:youtube});
      refresh();
    }
  }
  let generation = 0;
  async function readSettings() {
    const current = ++generation;
    const preferences = await chrome.storage.local.get({videoCaptions:true,targetLanguage:'zh-CN'});
    if (current === generation) configure(preferences);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.videoCaptions || changes.targetLanguage)) readSettings();
  });
  document.addEventListener('visibilitychange', refresh);
  readSettings();
})();
