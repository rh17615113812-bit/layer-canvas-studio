import { mkdir, access, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function extractModel(archive, name) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const path = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    const variant = name === 'chi_sim' ? '4.0.0' : '4.0.0_best_int';
    if (path === `package/${variant}/${name}.traineddata.gz`) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`模型包缺少 ${name} 文件`);
}

const dir = fileURLToPath(new URL('../ocr-data/', import.meta.url));
await mkdir(dir, { recursive: true });
for (const lang of ['chi_sim', 'eng']) {
  const target = `${dir}/${lang}.traineddata.gz`;
  if (await access(target).then(() => true, () => false)) { console.log(`${lang}: 已安装`); continue; }
  // npm verifies package integrity and respects the user's registry/network settings.
  const args = ['pack', `@tesseract.js-data/${lang}@1.0.0`, '--ignore-scripts', '--cache', '../node_modules/.cache/npm', '--silent'];
  const packed = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd: dir, encoding: 'utf8', timeout: 180_000, windowsHide: true })
    : spawnSync('npm', args, { cwd: dir, encoding: 'utf8', timeout: 180_000 });
  if (packed.error || packed.status !== 0) throw new Error(`下载 ${lang} 失败：${packed.error?.message || packed.stderr?.slice(-2000)}`);
  const archivePath = `${dir}/tesseract.js-data-${lang}-1.0.0.tgz`;
  const data = extractModel(await readFile(archivePath), lang);
  if (gunzipSync(data).length < 100_000) throw new Error(`${lang} 模型文件无效`);
  const temporary = `${target}.tmp`;
  try { await writeFile(temporary, data); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); await rm(archivePath, { force: true }); }
  console.log(`${lang}: 已安装 ${(data.length / 1024 / 1024).toFixed(1)} MB`);
}
