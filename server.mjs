import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': 'http://127.0.0.1:5173' }); res.end(JSON.stringify(body)); };
const API_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations';
const MODEL = process.env.ARK_SEEDREAM_MODEL || 'doubao-seedream-5-0-pro';
const VISION_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const VISION_MODEL = process.env.ARK_VISION_MODEL || 'doubao-seed-2-0-lite-260215';
const visionText = (data) => {
  const choice = data?.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  if (Array.isArray(choice)) return choice.map(part => typeof part === 'string' ? part : part?.text || '').join('');
  if (typeof data?.output_text === 'string') return data.output_text;
  const output = data?.output;
  if (Array.isArray(output)) return output.flatMap(item => Array.isArray(item?.content) ? item.content : []).map(part => part?.text || part?.value || '').join('');
  if (typeof output?.text === 'string') return output.text;
  return '';
};
const parseVisionJson = (data) => {
  const text = visionText(data).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('视觉模型未返回 JSON。');
  const parsed = JSON.parse(text.slice(start, end + 1));
  return { coordinateSpace: String(parsed.coordinate_space || '').toLowerCase(), boxes: Array.isArray(parsed.boxes) ? parsed.boxes : [] };
};
const normalizeVisionBoxes = (boxes, width, height, coordinateSpace = '') => boxes.map((item, index) => {
  const raw = Array.isArray(item?.bbox) ? item.bbox.map(Number) : [];
  if (raw.length !== 4 || raw.some(value => !Number.isFinite(value))) return null;
  const space = coordinateSpace.replace(/[-\s]/g, '_');
  const normalized = space === 'normalized' || space === 'normalized_01' || raw.every(value => value >= 0 && value <= 1) ? [raw[0] * width, raw[1] * height, raw[2] * width, raw[3] * height] : space === 'normalized_1000' || space === '0_1000' ? [raw[0] * width / 1000, raw[1] * height / 1000, raw[2] * width / 1000, raw[3] * height / 1000] : raw;
  const left = Math.max(0, Math.min(width - 2, Math.min(normalized[0], normalized[2]))), top = Math.max(0, Math.min(height - 2, Math.min(normalized[1], normalized[3]))), right = Math.max(left + 2, Math.min(width, Math.max(normalized[0], normalized[2]))), bottom = Math.max(top + 2, Math.min(height, Math.max(normalized[1], normalized[3])));
  return { name: String(item?.name || `区域 ${index + 1}`), type: item?.type === 'text' ? 'text' : 'ui', bbox: [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)], confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)) };
}).filter(Boolean);

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': 'http://127.0.0.1:5173', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  if (req.method !== 'POST' || !['/api/seedream/layer-split', '/api/vision/boxes'].includes(req.url)) return json(res, 404, { error: 'Not found' });
  if (!process.env.ARK_API_KEY) return json(res, 503, { error: '未配置 ARK_API_KEY。请复制 .env.example 为 .env.local，并填入方舟 API Key。' });
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 28 * 1024 * 1024) return json(res, 413, { error: '图片过大，请压缩至 20MB 以下后再试。' }); }
  try {
    const { image, prompt, metadata } = JSON.parse(raw);
    if (typeof image !== 'string' || !image.startsWith('data:image/')) return json(res, 400, { error: '需要一张本地图片。' });
    if (req.url === '/api/vision/boxes') {
      const visionPrompt = `识别图片中可独立编辑的游戏 UI 元素和程序文字。输入原图像素尺寸为 width=${Number(metadata?.width) || 1}, height=${Number(metadata?.height) || 1}。只返回纯 JSON，不要 Markdown，不要解释：{"coordinate_space":"pixel","boxes":[{"name":"...","type":"ui|text","bbox":[left,top,right,bottom],"confidence":0-1}]}。coordinate_space 必须是 pixel；bbox 必须使用输入图片原始像素坐标，覆盖按钮、图标、面板、文字等可独立编辑区域，避免返回整个画布。`;
      const upstream = await fetch(VISION_API_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.ARK_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: VISION_MODEL, temperature: 0.1, messages: [{ role: 'user', content: [{ type: 'text', text: visionPrompt }, { type: 'image_url', image_url: { url: image } }] }] }) });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return json(res, upstream.status, { error: data?.error?.message || data?.message || '视觉定位请求失败' });
      let width = Number(metadata?.width) || 1, height = Number(metadata?.height) || 1;
      const parsed = parseVisionJson(data);
      const boxes = normalizeVisionBoxes(parsed.boxes, width, height, parsed.coordinateSpace);
      return json(res, 200, { coordinate_space: parsed.coordinateSpace || 'pixel', boxes });
    }
    const upstream = await fetch(API_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.ARK_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, prompt: prompt || '将输入图片拆分为可编辑的独立 UI 或前景图层，保留原始像素尺寸和布局。', image, layer_decomposition: true, response_format: 'b64_json', output_format: 'png', watermark: false }) });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json(res, upstream.status, { error: data?.error?.message || data?.message || 'Seedream 请求失败', detail: data });
    json(res, 200, data);
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '请求格式无效' }); }
}).listen(8787, '127.0.0.1', () => console.log(`Seedream API proxy listening on http://127.0.0.1:8787 (model: ${MODEL})`));
