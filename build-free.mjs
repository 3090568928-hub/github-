import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const source = await realpath(fileURLToPath(new URL('./free', import.meta.url)));
const lock = JSON.parse(await readFile(new URL('./free-dependencies.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: {
  out: { type: 'string' }, zip: { type: 'string' }, cache: { type: 'string' }, help: { type: 'boolean' },
} });

function digest(bytes, algorithm = 'sha256', encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding);
}

async function readIfExists(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function verifiedAsset(cache, spec, name) {
  const file = path.join(cache, name);
  const matches = spec.integrity
    ? bytes => 'sha512-' + digest(bytes, 'sha512', 'base64') === spec.integrity
    : bytes => digest(bytes) === spec.sha256;
  const saved = await readIfExists(file);
  if (saved && matches(saved)) return file;

  console.log('下载并校验 ' + name);
  let bytes;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(spec.url, { signal: AbortSignal.timeout(90000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      bytes = Buffer.from(await response.arrayBuffer());
      if (!matches(bytes)) throw new Error('文件校验值不匹配');
      break;
    } catch (error) {
      if (attempt === 2) throw new Error(name + ' 下载或校验失败：' + error.message);
    }
  }
  const temporary = file + '.' + randomUUID() + '.part';
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}

function within(dir, target) {
  const relative = path.relative(dir, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

async function newPath(value) {
  // Resolve the parent so symlinks and directory junctions cannot put the stage in the source tree.
  const target = path.resolve(value);
  const resolved = path.join(await realpath(path.dirname(target)), path.basename(target));
  if (within(source, resolved)) throw new Error('请选择免费版源码目录以外的输出路径。');
  if (await lstat(resolved).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
    throw new Error('输出已存在：' + resolved);
  }
  return resolved;
}

async function includePackage(pkg, cache, scratch, stage) {
  const archive = await verifiedAsset(cache, pkg, path.basename(new URL(pkg.url).pathname));
  const extracted = await mkdtemp(path.join(scratch, 'package-'));
  await run('tar', ['-xf', archive, '-C', extracted], { windowsHide: true });
  const root = path.join(extracted, 'package');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error('依赖版本不匹配：' + pkg.name);
  for (const [from, to] of Object.entries(pkg.files)) {
    const destination = path.join(stage, to);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(root, from), destination, { recursive: true });
  }
  await rm(extracted, { recursive: true });
}

async function includeDictionary(cache, stage) {
  const dict = path.join(stage, 'github', 'dictionary.js');
  const local = await readIfExists(dict);
  if (local) {
    if (digest(local) !== lock.dictionary.sha256) throw new Error('本地 GitHub 界面词典与固定上游版本校验值不同。');
    return;
  }
  await copyFile(await verifiedAsset(cache, lock.dictionary, 'github-locals-3.1.4.js'), dict);
}

async function makeZip(stage, scratch, output) {
  // Use the same pinned JSZip already shipped for document import/export.
  const lib = path.join(scratch, 'jszip.cjs');
  await copyFile(path.join(stage, 'vendor/jszip.min.js'), lib);
  const Zip = createRequire(import.meta.url)(lib);
  const zip = new Zip();
  const date = new Date('2000-01-01T00:00:00Z');
  async function addDirectory(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) await addDirectory(file);
      else if (stat.isFile()) {
        const relative = path.relative(stage, file).split(path.sep).join('/');
        zip.file(relative, await readFile(file), { date, createFolders: false });
      } else throw new Error('扩展中存在无效的资源：' + file);
    }
  }
  await addDirectory(stage);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await writeFile(output, bytes, { flag: 'wx' });
}

async function build() {
  if (!values.out) throw new Error('用法：node build-free.mjs --out <新目录> [--zip <新文件>] [--cache <缓存目录>]');
  const out = await newPath(values.out);
  if (values.zip && within(out, path.resolve(values.zip))) throw new Error('ZIP 应放在生成目录以外。');
  const archive = values.zip ? await newPath(values.zip) : null;
  const cachePath = path.resolve(values.cache ?? path.join(os.homedir(), '.cache', 'github-translate-free'));
  if (within(source, cachePath) || within(out, cachePath)) throw new Error('缓存目录应放在源码和生成目录以外。');
  await mkdir(cachePath, { recursive: true });
  const cache = await realpath(cachePath);
  if (within(source, cache) || within(out, cache) || (archive && within(out, archive))) throw new Error('构建路径重叠。');

  const scratch = await mkdtemp(path.join(path.dirname(out), '.free-build-'));
  const stage = path.join(scratch, 'extension');
  const temporaryZip = archive && path.join(path.dirname(archive), '.free-archive-' + randomUUID() + '.zip');
  let publishedZip = false;
  try {
    await cp(source, stage, {
      recursive: true, filter: file => !['.git', '_metadata', 'vendor'].includes(path.basename(file)),
    });
    const manifest = JSON.parse(await readFile(path.join(stage, 'manifest.json'), 'utf8'));
    if (manifest.manifest_version !== 3) throw new Error('免费版需要 Manifest V3。');
    await includeDictionary(cache, stage);
    for (const pkg of lock.packages) await includePackage(pkg, cache, scratch, stage);
    await copyFile(await verifiedAsset(cache, lock.modelLicense, 'tessdata-LICENSE'), path.join(stage, 'image/vendor/LICENSE-tessdata'));
    if (archive) {
      await makeZip(stage, scratch, temporaryZip);
      try { await link(temporaryZip, archive); }
      catch (error) {
        // FAT/exFAT and some network shares cannot create hard links.
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
        await copyFile(temporaryZip, archive, constants.COPYFILE_EXCL);
      }
      publishedZip = true;
    }
    await rename(stage, out);
    console.log(out);
    if (archive) console.log(archive);
  } catch (error) {
    if (publishedZip) await rm(archive, { force: true });
    throw error;
  } finally {
    if (temporaryZip) await rm(temporaryZip, { force: true });
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (values.help) console.log('node build-free.mjs --out <新目录> [--zip <新文件>] [--cache <缓存目录>]');
else build().catch(error => { console.error(error.message); process.exitCode = 1; });
