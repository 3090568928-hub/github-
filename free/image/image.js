(() => {
  'use strict';
  const file = document.getElementById('file');
  const source = document.getElementById('source');
  const result = document.getElementById('result');
  const target = document.getElementById('target');
  const translate = document.getElementById('translate');
  const status = document.getElementById('status');
  const assets = chrome.runtime.getURL('image/vendor/');

  function lock(busy) {
    file.disabled = busy;
    source.readOnly = busy;
    target.disabled = busy;
    translate.disabled = busy || !source.value.trim();
  }

  file.addEventListener('change', async () => {
    const image = file.files[0];
    if (!image) return;
    source.value = result.value = '';
    lock(true);
    status.textContent = '正在准备本地识别引擎…';
    let worker;
    let bitmap;
    try {
      // Browser decoding covers WebP and GIF and flattens transparency for OCR.
      bitmap = await createImageBitmap(image);
      const scale = Math.min(1, Math.sqrt(16_000_000 / (bitmap.width * bitmap.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      worker = await Tesseract.createWorker('eng+chi_sim', 1, {
        workerPath: assets + 'worker.min.js',
        corePath: assets + 'tesseract-core-lstm.wasm.js',
        langPath: assets, workerBlobURL: false, cacheMethod: 'none',
        logger(event) {
          if (event.status === 'recognizing text') status.textContent = '正在识别 ' + Math.round(event.progress * 100) + '%';
        }
      });
      const {data} = await worker.recognize(canvas);
      source.value = data.text.trim();
      status.textContent = source.value ? '识别完成，可以校对后翻译。' : '没有识别到文字，可换一张更清晰的图片。';
    } catch (error) {
      status.textContent = '图片识别失败。' + (error.message || String(error));
    } finally {
      bitmap?.close();
      if (worker) await worker.terminate();
      lock(false);
    }
  });

  source.addEventListener('input', () => { result.value = ''; translate.disabled = !source.value.trim(); });
  target.addEventListener('change', () => { result.value = ''; });
  translate.addEventListener('click', async () => {
    const text = source.value.trim();
    if (!text) return;
    lock(true);
    result.value = '';
    status.textContent = '正在翻译文字…';
    try {
      const translated = [];
      // Bound each request even for an unusually dense scan. The worker
      // separately splits each part at sentence boundaries for the service.
      for (const block of text.match(/[\s\S]{1,16000}/gu)) {
        const [translation] = await geb.translate([block], target.value);
        translated.push(translation);
      }
      result.value = translated.join('\n');
      status.textContent = '翻译完成。';
    } catch (error) {
      status.textContent = error.message || '翻译失败，请稍后再试。';
    } finally { lock(false); }
  });
  chrome.storage.local.get({targetLanguage:'zh-CN'}).then(settings => {
    if (settings.targetLanguage === 'en') target.value = 'en';
  });
})();
