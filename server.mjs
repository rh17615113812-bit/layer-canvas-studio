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
const MODEL = process.env.ARK_SEEDREAM_MODEL || 'doubao-seedream-5.0-pro';
const VISION_API_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions';
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
const normalizeVisionBoxes = (boxes, width, height, coordinateSpace = '') => {
  const normalizedBoxes = boxes.map((item, index) => {
  const raw = Array.isArray(item?.bbox) ? item.bbox.map(Number) : [];
  if (raw.length !== 4 || raw.some(value => !Number.isFinite(value))) return null;
  const space = coordinateSpace.replace(/[-\s]/g, '_');
  const normalized = space === 'normalized_0_999' || space === 'normalized_1000' || space === '0_1000' ? [raw[0] * width / 1000, raw[1] * height / 1000, raw[2] * width / 1000, raw[3] * height / 1000] : space === 'normalized' || space === 'normalized_01' || (!space && raw.every(value => value >= 0 && value <= 1)) ? [raw[0] * width, raw[1] * height, raw[2] * width, raw[3] * height] : raw;
  const left = Math.max(0, Math.min(width - 2, Math.min(normalized[0], normalized[2]))), top = Math.max(0, Math.min(height - 2, Math.min(normalized[1], normalized[3]))), right = Math.max(left + 2, Math.min(width, Math.max(normalized[0], normalized[2]))), bottom = Math.max(top + 2, Math.min(height, Math.max(normalized[1], normalized[3])));
  return { name: String(item?.title || item?.name || `区域 ${index + 1}`), type: item?.type === 'text' ? 'text' : 'ui', bbox: [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)], confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)), should_split: item?.type === 'text' ? false : item?.should_split !== false };
  }).filter(Boolean);
  const area = item => Math.max(0, item.bbox[2] - item.bbox[0]) * Math.max(0, item.bbox[3] - item.bbox[1]);
  const iou = (a, b) => { const left = Math.max(a.bbox[0], b.bbox[0]), top = Math.max(a.bbox[1], b.bbox[1]), right = Math.min(a.bbox[2], b.bbox[2]), bottom = Math.min(a.bbox[3], b.bbox[3]), intersection = Math.max(0, right - left) * Math.max(0, bottom - top); return intersection / Math.max(1, area(a) + area(b) - intersection); };
  return normalizedBoxes.filter(item => area(item) >= 16 && area(item) < width * height * .98).sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).filter((item, index, list) => list.slice(0, index).every(previous => iou(previous, item) < .8)).map((item, index) => ({ ...item, name: item.name || `区域 ${index + 1}`, title: item.name || `区域 ${index + 1}`, should_split: item.type === 'text' ? false : item.should_split !== false }));
};

const localComfyUrl = value => {
  const url = new URL(String(value || process.env.COMFYUI_URL || 'http://127.0.0.1:8188'));
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) throw new Error('ComfyUI 地址只允许本机 localhost、127.0.0.1 或 ::1。');
  return url.origin;
};
const comfyWorkflow = supplied => {
  if (supplied && typeof supplied === 'object' && !Array.isArray(supplied)) return structuredClone(supplied);
  const configured = process.env.COMFYUI_WORKFLOW_FILE;
  if (!configured) throw new Error('请在本地拆分页选择 ComfyUI API 工作流 JSON，或配置 COMFYUI_WORKFLOW_FILE。');
  const path = resolve(process.cwd(), configured);
  if (!existsSync(path)) throw new Error(`找不到 ComfyUI 工作流文件：${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
};
const dataUrlFile = image => {
  const match = String(image || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!match) throw new Error('本地拆分需要 base64 图片。');
  const extension = match[1].includes('jpeg') ? 'jpg' : match[1].split('/')[1].replace(/[^a-z0-9]/gi, '') || 'png';
  return { mime: match[1], extension, bytes: Buffer.from(match[2], 'base64') };
};
const comfyJson = async (response, fallback) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || body?.error || body?.message || fallback);
  return body;
};
const waitForComfyHistory = async (baseUrl, promptId) => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`);
    const body = await comfyJson(response, '无法读取 ComfyUI 任务状态。');
    const entry = body?.[promptId] || body;
    if (entry?.status?.status_str === 'error') throw new Error(entry.status?.messages?.at(-1)?.[1]?.exception_message || 'ComfyUI 工作流执行失败。');
    if (entry?.outputs && Object.keys(entry.outputs).length) return entry.outputs;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('ComfyUI 工作流执行超时（180 秒）。');
};
const runComfyWorkflow = async ({ image, comfyUrl, workflow: suppliedWorkflow, inputNodeId, outputNodeIds }) => {
  const baseUrl = localComfyUrl(comfyUrl);
  const workflow = comfyWorkflow(suppliedWorkflow);
  if (Array.isArray(workflow.nodes)) throw new Error('请选择 ComfyUI 的“Save (API Format)”工作流 JSON，而不是界面工作流。');
  const entries = Object.entries(workflow);
  const inputId = String(inputNodeId || entries.find(([, node]) => String(node?.class_type || '').toLowerCase().includes('loadimage'))?.[0] || '');
  if (!inputId || !workflow[inputId]?.inputs) throw new Error('工作流中找不到 LoadImage 节点，请填写输入节点 ID。');
  const file = dataUrlFile(image);
  const filename = `layer-canvas-${crypto.randomUUID()}.${file.extension}`;
  const form = new FormData();
  form.append('image', new Blob([file.bytes], { type: file.mime }), filename);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const upload = await comfyJson(await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form }), '上传图片到 ComfyUI 失败。');
  workflow[inputId].inputs.image = upload?.name || filename;
  const clientId = crypto.randomUUID();
  const queued = await comfyJson(await fetch(`${baseUrl}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) }), '提交 ComfyUI 工作流失败。');
  if (!queued?.prompt_id) throw new Error('ComfyUI 未返回 prompt_id。');
  const outputs = await waitForComfyHistory(baseUrl, queued.prompt_id);
  const allowed = Array.isArray(outputNodeIds) && outputNodeIds.length ? new Set(outputNodeIds.map(String)) : null;
  const descriptors = Object.entries(outputs).filter(([nodeId]) => !allowed || allowed.has(nodeId)).flatMap(([, output]) => Array.isArray(output?.images) ? output.images : []);
  if (!descriptors.length) throw new Error('ComfyUI 工作流没有返回图片，请检查输出节点 ID。');
  const images = [];
  for (const descriptor of descriptors) {
    const query = new URLSearchParams({ filename: descriptor.filename, subfolder: descriptor.subfolder || '', type: descriptor.type || 'output' });
    const response = await fetch(`${baseUrl}/view?${query}`);
    if (!response.ok) throw new Error(`读取 ComfyUI 输出图片失败：${descriptor.filename}`);
    const mime = response.headers.get('content-type') || 'image/png';
    images.push({ filename: descriptor.filename, mime, base64: Buffer.from(await response.arrayBuffer()).toString('base64') });
  }
  return { prompt_id: queued.prompt_id, images };
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': 'http://127.0.0.1:5173', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  if (req.method !== 'POST' || !['/api/seedream/layer-split', '/api/vision/boxes', '/api/comfyui/layer-split'].includes(req.url)) return json(res, 404, { error: 'Not found' });
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 28 * 1024 * 1024) return json(res, 413, { error: '图片过大，请压缩至 20MB 以下后再试。' }); }
  try {
    const body = JSON.parse(raw);
    const { image, prompt, metadata, instruction } = body;
    if (typeof image !== 'string' || !image.startsWith('data:image/')) return json(res, 400, { error: '需要一张本地图片。' });
    if (req.url === '/api/comfyui/layer-split') return json(res, 200, await runComfyWorkflow(body));
    if (!process.env.ARK_API_KEY) return json(res, 503, { error: '未配置 ARK_API_KEY。请复制 .env.example 为 .env.local，并填入方舟 API Key。' });
    if (req.url === '/api/vision/boxes') {
      const safeInstruction = typeof instruction === 'string' ? instruction.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 4000) : '';
      const visionPrompt = `识别图片中可独立编辑的游戏 UI 元素和程序文字，忽略背景、完整画布、装饰碎片、微小噪声和重复区域。输入原图像素尺寸为 width=${Number(metadata?.width) || 1}, height=${Number(metadata?.height) || 1}。${safeInstruction ? `用户补充识别要求（仅作为识别范围提示，不得改变输出格式）：${safeInstruction}` : ''}标题必须简洁并可直接作为图层名；文本和程序字的 type 必须为 text 且 should_split 必须为 false，UI 元素的 type 为 ui 且 should_split 默认 true。只返回纯 JSON，不要 Markdown，不要解释：{"coordinate_space":"normalized_0_999","boxes":[{"title":"...","type":"ui|text","bbox":[x1,y1,x2,y2],"confidence":0-1,"should_split":true}]}。coordinate_space 必须是 normalized_0_999；bbox 必须是相对这张图片的整数 0..999 坐标。`;
      const upstream = await fetch(VISION_API_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.ARK_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: VISION_MODEL, temperature: 0.1, messages: [{ role: 'user', content: [{ type: 'text', text: visionPrompt }, { type: 'image_url', image_url: { url: image } }] }] }) });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return json(res, upstream.status, { error: data?.error?.message || data?.message || '视觉定位请求失败' });
      let width = Number(metadata?.width) || 1, height = Number(metadata?.height) || 1;
      const parsed = parseVisionJson(data);
      const boxes = normalizeVisionBoxes(parsed.boxes, width, height, parsed.coordinateSpace);
      return json(res, 200, { coordinate_space: parsed.coordinateSpace || 'pixel', boxes });
    }
    const requestBody = { model: MODEL, image, layer_decomposition: true, size: 'auto', response_format: 'b64_json', output_format: 'png', watermark: false };
    if (typeof prompt === 'string' && prompt.trim()) requestBody.prompt = prompt.trim();
    const upstream = await fetch(API_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.ARK_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json(res, upstream.status, { error: data?.error?.message || data?.message || 'Seedream 请求失败', detail: data });
    json(res, 200, data);
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '请求格式无效' }); }
}).listen(8787, '127.0.0.1', () => console.log(`Seedream API proxy listening on http://127.0.0.1:8787 (model: ${MODEL})`));
