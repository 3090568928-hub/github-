import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function integratePreferences({ outDir }) {
  const worker = path.join(outDir, 'background.js');
  const upstream = await readFile(worker, 'utf8');
  // The 1.35.2 worker has one accessor for the native local user config.
  // Wait for the one-time change before any of its startup migrations read it.
  const getter = 'function Dr(){return ee.local.get(ji,{})}';
  if (upstream.split(getter).length !== 2) throw new Error('无法识别沉浸式翻译的配置读取入口');

  const init = await readFile(new URL('./preferences/initialize.js', import.meta.url), 'utf8');
  const updated = upstream.replace(getter, 'async function Dr(){await bundlePreferencesReady;return ee.local.get(ji,{})}');
  await writeFile(worker, init + '\n' + updated);
}
