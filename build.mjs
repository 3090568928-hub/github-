import { cp, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { integrateGithub } from './integration/github.mjs';
import { applyIdentity } from './integration/identity.mjs';
import { integratePreferences } from './integration/preferences.mjs';

const installed = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Microsoft', 'Edge', 'User Data', 'Default', 'Extensions');
const { values } = parseArgs({ options: {
  immersive: { type: 'string', default: path.join(installed, 'amkbmndfnliijdhojkpoglbnaaahippg', '1.35.2_0') },
  github: { type: 'string', default: path.join(installed, 'gafbkmdjmeamppdonbdcoekfcagfpcck', '3.1.4_0') },
  out: { type: 'string', default: 'translation-bundle-local' },
} });

async function readManifest(directory, version, popup) {
  const json = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (json.version !== version || json.manifest_version !== 3 || json.action?.default_popup !== popup ||
      json.background?.service_worker !== 'background.js' || json.background.type === 'module') {
    throw new Error(`不支持的输入：${directory}。需要与版本 ${version} 匹配的 Edge 扩展。`);
  }
  return json;
}

async function addPanelNavigation(outDir, file, mode) {
  const prefix = mode === 'immersive' ? './' : '../../';
  const contents = await readFile(path.join(outDir, file), 'utf8');
  if (!contents.includes('</head>') || !contents.includes('<body>')) {
    throw new Error(`面板结构已改变：${file}`);
  }
  const nav = [
    '<nav class="bundle-panels" aria-label="翻译面板">',
    mode === 'immersive' ? '<span aria-current="page">沉浸式翻译</span>' : '<a href="../../popup.html">沉浸式翻译</a>',
    mode === 'github' ? '<span aria-current="page">GitHub 汉化</span>' : '<a href="./github-zh/popup/popup.html">GitHub 汉化</a>',
    '</nav>',
  ].join('\n');
  const html = contents.replace('</head>', `<link rel="stylesheet" href="${prefix}bundle-panels.css">\n</head>`)
    .replace('<body>', `<body>\n${nav}`);
  await writeFile(path.join(outDir, file), html);
}

async function build() {
  const immersive = await realpath(values.immersive);
  const githubDir = await realpath(values.github);
  const out = path.resolve(values.out);
  // Build in a fresh sibling directory so failures leave any previous build alone.
  const parent = await realpath(path.dirname(out));
  for (const source of [immersive, githubDir]) {
    const relative = path.relative(source, parent);
    if (!(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) {
      throw new Error('输出目录不能位于原扩展内。');
    }
  }
  if (await lstat(out).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
    throw new Error(`输出已存在，请选择新目录：${out}`);
  }
  const manifest = await readManifest(immersive, '1.35.2', 'popup.html');
  const github = await readManifest(githubDir, '3.1.4', 'popup/popup.html');
  const stage = await mkdtemp(path.join(parent, '.translation-build-'));
  try {
    await cp(immersive, stage, {
      recursive: true,
      filter: src => !['_metadata', '.git'].includes(path.basename(src)),
    });
    await integrateGithub({ githubDir, outDir: stage });
    await applyIdentity({ manifest, outDir: stage });
    await integratePreferences({ outDir: stage });
    delete manifest.update_url;
    // Keep page translation available from the panel and leave Alt+A to WeChat.
    delete manifest.commands.toggleTranslatePage.suggested_key;
    manifest.name = '沉浸式翻译 + GitHub 汉化';
    manifest.short_name = '双语翻译与汉化';
    manifest.version_name = '1.35.2 + GitHub 汉化 3.1.4';
    manifest.action.default_title = manifest.name;
    manifest.background.service_worker = 'bundle-worker.js';
    manifest.content_scripts.push({
      matches: github.content_scripts[0].matches,
      run_at: github.content_scripts[0].run_at,
      js: ['github-zh/content.js'],
    });
    // The base already has <all_urls> and storage access. No extra grants needed.
    await writeFile(path.join(stage, 'bundle-worker.js'), "importScripts('github-zh/background.js');\nimportScripts('background.js');\n");
    await cp(new URL('./integration/panels.css', import.meta.url), path.join(stage, 'bundle-panels.css'));
    await addPanelNavigation(stage, 'popup.html', 'immersive');
    await addPanelNavigation(stage, 'github-zh/popup/popup.html', 'github');
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rename(stage, out);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  console.log(out);
}

build().catch(error => { console.error(error.message); process.exitCode = 1; });
