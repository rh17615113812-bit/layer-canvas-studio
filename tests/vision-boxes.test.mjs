import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { normalizeVisionBoxes, refineHeaderBoxes, runVisionBoxes } from '../visionBoxes.mjs';

test('normalized coordinate edges and header refinements map to original image pixels', () => {
  const full = [{ title: '资源条', bbox: [100, 20, 300, 50], confidence: .9 }, { title: '底部按钮', bbox: [100, 800, 300, 900] }];
  assert.deepEqual(normalizeVisionBoxes([{ bbox: [0, 0, 999, 999] }], 1170, 2532)[0].bbox, [0, 0, 1170, 2532]);
  assert.deepEqual(normalizeVisionBoxes([{ bbox: [0, 0, 1000, 1000] }], 1170, 2532, '0_1000')[0].bbox, [0, 0, 1170, 2532]);
  const refined = refineHeaderBoxes(full, [{ box_index: 0, bbox: [100, 200, 300, 300] }, { box_index: 1, bbox: [0, 10, 100, 100] }], 1170, 2532, 633, 'normalized_0_999');
  assert.deepEqual(normalizeVisionBoxes(refined, 1170, 2532)[0].bbox, [117, 127, 351, 190]);
  assert.deepEqual(refined[1], full[1], 'lower regions must stay unchanged');
  assert.deepEqual(refineHeaderBoxes(full, [{ box_index: 0, bbox: [0, 0, 999, 999] }], 1170, 2532, 633, 'normalized_0_999'), full);
});

test('portrait detection sends a true top crop in one request and returns pixel coordinates', async () => {
  const canvas = createCanvas(120, 260), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 120, 65);
  ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 65, 120, 195);
  let calls = 0;
  const result = await runVisionBoxes({ image: canvas.toDataURL('image/png'), apiKey: 'test', apiUrl: 'https://example.invalid', model: 'test' }, async (_, options) => {
    calls++;
    const content = JSON.parse(options.body).messages[0].content;
    assert.equal(content.length, 3);
    const crop = await loadImage(Buffer.from(content[2].image_url.url.split(',')[1], 'base64'));
    assert.equal(crop.width, 120); assert.equal(crop.height, 65);
    const check = createCanvas(120, 65), checkCtx = check.getContext('2d'); checkCtx.drawImage(crop, 0, 0);
    assert.deepEqual([...checkCtx.getImageData(60, 64, 1, 1).data], [255, 0, 0, 255]);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ coordinate_space: 'normalized_0_999',
      boxes: [{ title: '资源条', bbox: [100, 20, 300, 50], confidence: .9 }],
      header_refinements: [{ box_index: 0, bbox: [100, 200, 300, 300] }],
    }) } }] }) };
  });
  assert.equal(calls, 1); assert.equal(result.coordinate_space, 'pixel');
  assert.deepEqual(result.boxes[0].bbox, [12, 13, 36, 20]);
  await assert.rejects(runVisionBoxes({ image: canvas.toDataURL('image/png'), apiKey: 'test', apiUrl: 'test', model: 'test' }, async () => {
    calls++; return { ok: false, json: async () => ({ error: { message: 'provider failed' } }) };
  }), /provider failed/);
  assert.equal(calls, 2, 'upstream errors must not trigger a retry');
});
