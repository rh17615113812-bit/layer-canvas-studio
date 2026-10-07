import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { runLocalOcr, closeLocalOcr } from '../localOcr.mjs';
import { readFile, writeFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real local OCR recognizes Chinese and English with pixel bounds', async () => {
  GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'TestChinese');
  const canvas = createCanvas(640, 150), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 640, 150);
  ctx.fillStyle = '#000000'; ctx.font = '36px TestChinese';
  ctx.fillText('开始游戏', 35, 55); ctx.fillText('START GAME 123', 35, 115);
  try {
    const result = await runLocalOcr({ image: canvas.toDataURL('image/png'), width: 640, height: 150 });
    const text = result.regions.map(region => region.text).join('\n');
    assert.match(text, /开始游戏/); assert.match(text, /START GAME 123/);
    assert.equal(result.coordinate_space, 'pixel');
    for (const region of result.regions) {
      assert.ok(region.bbox[0] >= 0 && region.bbox[2] <= 640);
      assert.ok(region.bbox[1] >= 0 && region.bbox[3] <= 150);
    }
    await assert.rejects(runLocalOcr({ image: canvas.toDataURL('image/png'), width: 1, height: 1 }), /尺寸不一致/);
    ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, 640, 150);
    ctx.fillStyle = '#ffffff'; ctx.fillText('开始游戏', 35, 70);
    const light = await runLocalOcr({ image: canvas.toDataURL('image/png'), width: 640, height: 150 });
    assert.match(light.regions.map(region => region.text).join(''), /开始游戏/);
    assert.ok(parseInt(light.regions[0].style.color.slice(1, 3), 16) >= 240, 'white text should retain a light fill');
    ctx.clearRect(0, 0, 640, 150);
    ctx.fillStyle = '#ffffff'; ctx.fillText('开始游戏', 35, 70);
    const transparent = await runLocalOcr({ image: canvas.toDataURL('image/png'), width: 640, height: 150 });
    assert.match(transparent.regions.map(region => region.text).join(''), /开始游戏/);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 640, 150);
    const empty = await runLocalOcr({ image: canvas.toDataURL('image/png'), width: 640, height: 150 });
    assert.deepEqual(empty.regions, []);
  } finally { await closeLocalOcr(); }
});

test('HTTP OCR defaults to local without an API key and requires explicit cloud selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'layer-canvas-ocr-'));
  const path = join(directory, 'server.mjs');
  let child;
  try {
    const original = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
    const source = original.replace(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(`../${relative.slice(2)}`, import.meta.url).href}'`)
      .replace(/\.listen\(8787,[\s\S]*$/, '.listen(0, "127.0.0.1", function () { console.log("OCR_TEST_PORT=" + this.address().port); });');
    await writeFile(path, source);
    const environment = { ...process.env }; delete environment.ARK_API_KEY;
    delete environment.TENCENT_SECRET_ID; delete environment.TENCENT_SECRET_KEY;
    child = spawn(process.execPath, [path], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OCR test server startup timed out')), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`OCR server exited: ${code}`)); });
      child.stdout.on('data', data => {
        const match = String(data).match(/OCR_TEST_PORT=(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    const canvas = createCanvas(360, 90), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 360, 90);
    ctx.fillStyle = '#000000'; ctx.font = '36px TestChinese'; ctx.fillText('开始游戏', 30, 60);
    const body = { image: canvas.toDataURL('image/png'), metadata: { width: 360, height: 90 } };
    const post = value => fetch(`http://127.0.0.1:${port}/api/vision/ocr`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(30_000),
    });
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.match((await response.json()).regions.map(region => region.text).join(''), /开始游戏/);
    const cloud = await post({ ...body, provider: 'cloud' });
    assert.equal(cloud.status, 503);
    assert.equal((await post({ ...body, provider: 'invalid' })).status, 400);
    const configUrl = `http://127.0.0.1:${port}/api/ocr/tencent/config`;
    assert.deepEqual(await (await fetch(configUrl)).json(), { configured: false });
    const invalidOrigin = await fetch(configUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' }, body: '{}' });
    assert.equal(invalidOrigin.status, 403);
    const saved = await fetch(configUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ secretId: 'AKIDEXAMPLE1234', secretKey: 'example-secret-key-1234' }) });
    assert.deepEqual(await saved.json(), { configured: true });
    assert.deepEqual(await (await fetch(configUrl)).json(), { configured: true });
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    }
    await unlink(path).catch(() => undefined);
    await unlink(join(directory, '.env.local')).catch(() => undefined); await rmdir(directory);
  }
});
