import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTencentOcr, signTencentOcr } from '../tencentOcr.mjs';
import { saveTencentOcrConfig } from '../tencentOcrConfig.mjs';

test('Tencent high accuracy OCR signs the crop, maps original polygons and never retries', async () => {
  const input = { image: 'data:image/png;base64,ZmFrZQ==', width: 300, height: 100, secretId: 'AKIDEXAMPLE1234', secretKey: 'not-a-real-secret-key' };
  let calls = 0;
  const result = await runTencentOcr(input, async (url, options) => {
    calls++;
    assert.equal(url, 'https://ocr.tencentcloudapi.com/');
    assert.equal(options.headers['X-TC-Action'], 'GeneralAccurateOCR');
    assert.equal(options.headers['X-TC-Region'], 'ap-guangzhou');
    assert.match(options.headers.Authorization, /^TC3-HMAC-SHA256 Credential=/);
    assert.ok(!options.headers.Authorization.includes(input.secretKey));
    assert.deepEqual(JSON.parse(options.body), { ImageBase64: 'ZmFrZQ==', IsWords: false, ConfigID: 'OCR' });
    return { ok: true, json: async () => ({ Response: { RequestId: 'test', TextDetections: [
      { DetectedText: '7.迷失森林', Polygon: [{ X: 10, Y: 20 }, { X: 180, Y: 18 }, { X: 182, Y: 52 }, { X: 12, Y: 54 }], ItemPolygon: { X: 0, Y: 0, Width: 1, Height: 1 } },
      { DetectedText: '最高波次0/20', ItemPolygon: { X: 11, Y: 60, Width: 210, Height: 30 } },
    ] } }) };
  });
  assert.equal(calls, 1); assert.equal(result.coordinate_space, 'pixel');
  assert.deepEqual(result.regions.map(region => region.bbox), [[10, 18, 182, 54], [11, 60, 221, 90]]);
  assert.equal(result.regions[0].text, '7.迷失森林');
  await assert.rejects(runTencentOcr(input, async () => { calls++; return { ok: true, json: async () => ({ Response: { Error: { Code: 'FailedOperation.ResourcePackageRunOut' } } }) }; }), /免费资源包/);
  assert.equal(calls, 2);
  await assert.rejects(runTencentOcr(input, async () => { calls++; throw new Error('network'); }), /提交状态未知/);
  assert.equal(calls, 3);
  await assert.rejects(runTencentOcr({ ...input, secretKey: '' }), /尚未配置/);
  const headers = signTencentOcr('{}', input.secretId, input.secretKey, 0);
  assert.match(headers.Authorization, /1970-01-01\/ocr\/tc3_request/);
  assert.notEqual(headers.Authorization, signTencentOcr('{"x":1}', input.secretId, input.secretKey, 0).Authorization);
});

test('credential save preserves other providers and rejects line injection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tencent-ocr-config-')), path = join(dir, '.env.local');
  try {
    writeFileSync(path, 'ARK_API_KEY=existing-test-value\nTENCENT_SECRET_ID=old\nTENCENT_SECRET_KEY=old\n');
    saveTencentOcrConfig(dir, 'AKIDEXAMPLE1234', 'example-secret-key-1234');
    const saved = readFileSync(path, 'utf8');
    assert.match(saved, /ARK_API_KEY=existing-test-value/);
    assert.equal(saved.match(/TENCENT_SECRET_ID=/g).length, 1);
    assert.match(saved, /TENCENT_SECRET_KEY=example-secret-key-1234/);
    assert.throws(() => saveTencentOcrConfig(dir, 'AKIDEXAMPLE1234\nOTHER=oops', 'example-secret-key-1234'), /格式无效/);
  } finally { unlinkSync(path); rmdirSync(dir); }
});
