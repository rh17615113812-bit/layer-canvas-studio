import { createHash, createHmac } from 'node:crypto';

const host = 'ocr.tencentcloudapi.com';
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

export function signTencentOcr(payload, secretId, secretKey, timestamp = Math.floor(Date.now() / 1000)) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonical = `POST\n/\n\ncontent-type:${contentType}\nhost:${host}\n\ncontent-type;host\n${hash(payload)}`;
  const scope = `${date}/ocr/tc3_request`;
  const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`;
  const signingKey = hmac(hmac(hmac(`TC3${secretKey}`, date), 'ocr'), 'tc3_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return {
    'Content-Type': contentType, Host: host,
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    'X-TC-Action': 'GeneralAccurateOCR', 'X-TC-Version': '2018-11-19',
    'X-TC-Timestamp': String(timestamp), 'X-TC-Region': 'ap-guangzhou',
  };
}

export async function runTencentOcr({ image, width, height, secretId, secretKey }, request = fetch) {
  if (!secretId || !secretKey) throw new Error('尚未配置腾讯云密钥，请打开“腾讯云 OCR 配置”。');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('文字框尺寸无效。');
  if (typeof image !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(image)) throw new Error('腾讯云 OCR 需要 PNG/JPEG 图片。');
  const base64 = image.slice(image.indexOf(',') + 1);
  if (base64.length > 10 * 1024 * 1024) throw new Error('文字框裁切图片超过腾讯云 10 MB 限制，请缩小框选。');
  const payload = JSON.stringify({ ImageBase64: base64, IsWords: false, ConfigID: 'OCR' });
  let response;
  try {
    response = await request(`https://${host}/`, { method: 'POST', headers: signTencentOcr(payload, secretId, secretKey),
      body: payload, signal: AbortSignal.timeout(60_000) });
  } catch { throw new Error('腾讯云请求超时或网络异常，提交状态未知；未自动重试，请确认额度记录后手动重试。'); }
  const result = (await response.json().catch(() => ({}))).Response;
  if (!response.ok || result?.Error) {
    const code = result?.Error?.Code || `HTTP${response.status}`;
    const message = /Resource|Quota|LimitExceeded/.test(code) ? '免费资源包可能已耗尽或接口限流；请检查腾讯云额度与服务设置，未切换付费接口。'
      : /AuthFailure|Unauthorized/.test(code) ? '腾讯云密钥或 OCR 权限无效，请检查密钥和权限。'
      : /ServiceNotActivated|UnOpen|NoPermission/.test(code) ? '请先在腾讯云控制台开通文字识别服务。' : '腾讯云 OCR 调用失败。';
    throw new Error(`${message}（${code}）`);
  }
  if (!Array.isArray(result?.TextDetections)) throw new Error('腾讯云未返回有效文字识别结果，未自动重试。');
  return { provider: 'tencent', coordinate_space: 'pixel', requestId: result.RequestId,
    regions: result.TextDetections.flatMap(item => {
      const text = typeof item.DetectedText === 'string' ? item.DetectedText.trim() : '';
      const polygon = Array.isArray(item.Polygon) ? item.Polygon : [];
      const rect = item.ItemPolygon;
      const validPoints = polygon.length >= 4 && polygon.every(point => Number.isFinite(point.X) && Number.isFinite(point.Y));
      const bbox = validPoints ? [Math.min(...polygon.map(point => point.X)), Math.min(...polygon.map(point => point.Y)),
        Math.max(...polygon.map(point => point.X)), Math.max(...polygon.map(point => point.Y))]
        : rect ? [rect.X, rect.Y, rect.X + rect.Width, rect.Y + rect.Height] : [];
      if (!text || bbox.length !== 4 || bbox.some(value => !Number.isFinite(value)) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return [];
      return [{ text, bbox, style: { font_family: 'Microsoft YaHei', font_size: Math.max(8, bbox[3] - bbox[1]),
        color: '#ffffff', bold: false, italic: false, align: 'left', vertical_align: 'top', line_height: 1.2, letter_spacing: 0, stroke_width: 0 } }];
    }),
  };
}
