import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { runVisionOcr } from './visionOcr.mjs';
import { runLocalOcr } from './localOcr.mjs';
import { runTencentOcr } from './tencentOcr.mjs';
import { saveTencentOcrConfig } from './tencentOcrConfig.mjs';
import { runVisionBoxes } from './visionBoxes.mjs';

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
const localComfyUrl = value => {
  const url = new URL(String(value || process.env.COMFYUI_URL || 'http://127.0.0.1:8188'));
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1'
    || (isIP(hostname) === 4 && hostname.startsWith('127.'));
  const privateIpv4 = isIP(hostname) === 4 && (() => {
    const [first, second] = hostname.split('.').map(Number);
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  })();
  const privateIpv6 = isIP(hostname) === 6 && /^(fc|fd|fe[89ab])/i.test(hostname);
  if (!['http:', 'https:'].includes(url.protocol) || !(loopback || privateIpv4 || privateIpv6)) throw new Error('ComfyUI 地址仅支持本机或私有局域网 IP（IPv4/IPv6），不支持公网地址。');
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
const runComfyWorkflow = async ({ image, comfyUrl, workflow: suppliedWorkflow, inputNodeId, outputNodeIds, promptOverride }) => {
  const baseUrl = localComfyUrl(comfyUrl);
  const workflow = comfyWorkflow(suppliedWorkflow);
  if (Array.isArray(workflow.nodes)) throw new Error('请选择 ComfyUI 的“Save (API Format)”工作流 JSON，而不是界面工作流。');
  const entries = Object.entries(workflow);
  const inputId = String(inputNodeId || entries.find(([, node]) => String(node?.class_type || '').toLowerCase().includes('loadimage'))?.[0] || '');
  if (!inputId || !workflow[inputId]?.inputs) throw new Error('工作流中找不到 LoadImage 节点，请填写输入节点 ID。');
  if (promptOverride !== undefined) {
    const promptNodeId = String(promptOverride?.nodeId || '').trim();
    const promptFieldName = String(promptOverride?.fieldName || '').trim();
    const prompt = typeof promptOverride?.prompt === 'string' ? promptOverride.prompt.trim() : '';
    const promptInputs = workflow[promptNodeId]?.inputs;
    if (!promptNodeId || !promptFieldName || !prompt) throw new Error('ComfyUI 提示词节点 ID、字段名和提示词都必须填写。');
    if (!promptInputs || typeof promptInputs[promptFieldName] !== 'string') throw new Error(`ComfyUI 提示词节点 ${promptNodeId} 的文本字段 ${promptFieldName} 不存在。`);
    promptInputs[promptFieldName] = prompt;
  }
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
const runningHubFailure = (body, fallback) => {
  const data = body?.data && typeof body.data === 'object' ? body.data : body;
  const code = data?.errorCode ?? body?.errorCode ?? body?.code;
  const message = data?.errorMessage || data?.message || body?.errorMessage || body?.message || data?.error?.message || body?.error?.message || data?.error || body?.error;
  const detail = typeof message === 'string' ? message.replace(/[\r\n]+/g, ' ').trim().slice(0, 500) : '';
  return `${fallback}${code !== undefined && code !== '' ? `（错误码 ${code}）` : ''}${detail ? `：${detail}` : ''}`;
};
const runningHubJson = async (response, fallback) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (Number.isFinite(Number(body?.code)) && Number(body.code) !== 0)) throw new Error(runningHubFailure(body, fallback));
  return body;
};
const runningHubData = body => body?.data && typeof body.data === 'object' ? body.data : body;
const runningHubStatus = body => String(runningHubData(body)?.status || body?.status || '').toUpperCase();
const runRunningHubWorkflow = async ({ image, config = {}, promptOverride }) => {
  const apiKey = process.env.RUNNINGHUB_API_KEY;
  if (!apiKey) throw new Error('未配置 RUNNINGHUB_API_KEY。请仅在本机 .env.local 中填写。');
  const workflowId = String(config.workflowId || process.env.RUNNINGHUB_WORKFLOW_ID || '').trim();
  const inputNodeId = String(config.inputNodeId || '').trim();
  const inputFieldName = String(config.inputFieldName || 'image').trim();
  const promptNodeId = String(promptOverride?.nodeId || '').trim();
  const promptFieldName = String(promptOverride?.fieldName || '').trim();
  const backgroundPrompt = typeof promptOverride?.prompt === 'string' ? promptOverride.prompt.trim() : '';
  if (!workflowId) throw new Error('请在 RunningHub 配置中填写工作流 API ID，或配置 RUNNINGHUB_WORKFLOW_ID。');
  if (!inputNodeId) throw new Error('请在 RunningHub 配置中填写图片输入节点 ID。');
  if (promptOverride !== undefined && (!promptNodeId || !promptFieldName || !backgroundPrompt)) throw new Error('背景分离提示词节点 ID、字段名和提示词都必须填写。');
  const file = dataUrlFile(image);
  const form = new FormData();
  form.append('file', new Blob([file.bytes], { type: file.mime }), `layer-canvas-${crypto.randomUUID()}.${file.extension}`);
  const headers = { Authorization: `Bearer ${apiKey}` };
  const uploaded = await runningHubJson(await fetch('https://www.runninghub.cn/openapi/v2/media/upload/binary', { method: 'POST', headers, body: form }), '上传图片到 RunningHub 失败。');
  const imageUrl = runningHubData(uploaded)?.download_url || uploaded?.download_url;
  if (!imageUrl) throw new Error('RunningHub 上传接口没有返回 download_url。');
  const instanceType = ['default', 'plus', 'ultra'].includes(config.instanceType) ? config.instanceType : 'default';
  const nodeInfoList = inputNodeId ? [{ nodeId: inputNodeId, fieldName: inputFieldName, fieldValue: imageUrl, description: 'Layer Canvas 拆分区域输入图' }] : [];
  if (promptOverride !== undefined) nodeInfoList.push({ nodeId: promptNodeId, fieldName: promptFieldName, fieldValue: backgroundPrompt, description: 'Layer Canvas 背景分离提示词' });
  const submitted = await runningHubJson(await fetch(`https://www.runninghub.cn/openapi/v2/run/workflow/${encodeURIComponent(workflowId)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ addMetadata: config.addMetadata === true, nodeInfoList, instanceType, usePersonalQueue: config.usePersonalQueue === true }),
  }), '提交 RunningHub 工作流失败。');
  const submittedData = runningHubData(submitted);
  const taskId = String(submittedData?.taskId || submitted?.taskId || '');
  if (!taskId) throw new Error(runningHubFailure(submitted, 'RunningHub 未返回 taskId，任务未进入可查询状态'));
  if (runningHubStatus(submitted) === 'FAILED') throw new Error(`RunningHub 任务 ${taskId} 提交失败。`);
  const deadline = Date.now() + 180000;
  let last = submitted;
  while (Date.now() < deadline) {
    const status = runningHubStatus(last);
    if (status === 'SUCCESS') break;
    if (status === 'FAILED') throw new Error(`RunningHub 任务 ${taskId} 执行失败。`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    last = await runningHubJson(await fetch('https://www.runninghub.cn/openapi/v2/query', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }) }), `无法查询 RunningHub 任务 ${taskId}。`);
  }
  if (runningHubStatus(last) !== 'SUCCESS') throw new Error(`RunningHub 任务 ${taskId} 状态未知或超时；系统未自动重试，请在 RunningHub 控制台确认后手动重试。`);
  const resultData = runningHubData(last);
  const allResults = Array.isArray(resultData?.results) ? resultData.results : Array.isArray(last?.results) ? last.results : [];
  const allowed = Array.isArray(config.outputNodeIds) && config.outputNodeIds.length ? new Set(config.outputNodeIds.map(String)) : null;
  const result = allResults.find(item => typeof item?.url === 'string' && (!allowed || allowed.has(String(item.nodeId))));
  if (!result?.url) throw new Error('RunningHub 工作流没有返回匹配的图片，请检查输出节点 ID。');
  const output = await fetch(result.url);
  if (!output.ok) throw new Error('无法读取 RunningHub 输出图片。');
  return { taskId, mime: output.headers.get('content-type') || 'image/png', base64: Buffer.from(await output.arrayBuffer()).toString('base64') };
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': 'http://127.0.0.1:5173', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  if (req.url === '/api/ocr/tencent/config') {
    if (req.method === 'GET') return json(res, 200, { configured: !!(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY) });
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (req.headers.origin !== 'http://127.0.0.1:5173' || !String(req.headers['content-type']).startsWith('application/json')) return json(res, 403, { error: '只允许本机工具页面配置密钥。' });
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw new Error('配置内容过大。'); }
      const body = JSON.parse(raw);
      const saved = saveTencentOcrConfig(process.cwd(), body.secretId, body.secretKey);
      process.env.TENCENT_SECRET_ID = saved.secretId; process.env.TENCENT_SECRET_KEY = saved.secretKey;
      return json(res, 200, { configured: true });
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : '无法保存配置。' }); }
  }
  if (req.method !== 'POST' || !['/api/seedream/layer-split', '/api/vision/boxes', '/api/vision/ocr', '/api/comfyui/layer-split', '/api/runninghub/layer-split'].includes(req.url)) return json(res, 404, { error: 'Not found' });
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 28 * 1024 * 1024) return json(res, 413, { error: '图片过大，请压缩至 20MB 以下后再试。' }); }
  try {
    const body = JSON.parse(raw);
    const { image, prompt, metadata, instruction } = body;
    if (typeof image !== 'string' || !image.startsWith('data:image/')) return json(res, 400, { error: '需要一张本地图片。' });
    if (req.url === '/api/comfyui/layer-split') return json(res, 200, await runComfyWorkflow(body));
    if (req.url === '/api/runninghub/layer-split') {
      const result = await runRunningHubWorkflow(body);
      return json(res, 200, { taskId: result.taskId, imageUrl: `data:${result.mime};base64,${result.base64}` });
    }
    if (req.url === '/api/vision/ocr' && (body.provider === undefined || body.provider === 'local')) {
      return json(res, 200, await runLocalOcr({ image, width: Number(metadata?.width), height: Number(metadata?.height) }));
    }
    if (req.url === '/api/vision/ocr' && body.provider === 'tencent') return json(res, 200, await runTencentOcr({
      image, width: Number(metadata?.width), height: Number(metadata?.height),
      secretId: process.env.TENCENT_SECRET_ID, secretKey: process.env.TENCENT_SECRET_KEY,
    }));
    if (req.url === '/api/vision/ocr' && body.provider !== 'cloud') return json(res, 400, { error: '未知 OCR 识别方式。' });
    if (!process.env.ARK_API_KEY) return json(res, 503, { error: '未配置 ARK_API_KEY。请复制 .env.example 为 .env.local，并填入方舟 API Key。' });
    if (req.url === '/api/vision/ocr') return json(res, 200, await runVisionOcr({
      image, width: Number(metadata?.width), height: Number(metadata?.height),
      apiKey: process.env.ARK_API_KEY, apiUrl: VISION_API_URL, model: VISION_MODEL,
    }));
    if (req.url === '/api/vision/boxes') return json(res, 200, await runVisionBoxes({
      image, instruction, apiKey: process.env.ARK_API_KEY, apiUrl: VISION_API_URL, model: VISION_MODEL,
    }));
    const requestBody = { model: MODEL, image, layer_decomposition: true, size: 'auto', response_format: 'b64_json', output_format: 'png', watermark: false };
    if (typeof prompt === 'string' && prompt.trim()) requestBody.prompt = prompt.trim();
    const upstream = await fetch(API_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.ARK_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json(res, upstream.status, { error: data?.error?.message || data?.message || 'Seedream 请求失败', detail: data });
    json(res, 200, data);
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '请求格式无效' }); }
}).listen(8787, '127.0.0.1', () => console.log(`Seedream API proxy listening on http://127.0.0.1:8787 (model: ${MODEL})`));
