import { createCanvas, loadImage } from '@napi-rs/canvas';

export function normalizeVisionBoxes(boxes, width, height, coordinateSpace = 'normalized_0_999') {
  const space = coordinateSpace.toLowerCase().replace(/[-\s]/g, '_');
  const denominator = space === 'normalized_0_999' ? 999 : ['normalized_1000', '0_1000'].includes(space) ? 1000 : null;
  return boxes.flatMap((item, index) => {
    const raw = Array.isArray(item?.bbox) ? item.bbox.map(Number) : [];
    if (raw.length !== 4 || raw.some(value => !Number.isFinite(value))) return [];
    const normalized = denominator ? raw.map((value, i) => value * (i % 2 ? height : width) / denominator)
      : ['normalized', 'normalized_01'].includes(space) ? raw.map((value, i) => value * (i % 2 ? height : width)) : raw;
    const left = Math.max(0, Math.min(width - 2, Math.min(normalized[0], normalized[2])));
    const top = Math.max(0, Math.min(height - 2, Math.min(normalized[1], normalized[3])));
    const right = Math.max(left + 2, Math.min(width, Math.max(normalized[0], normalized[2])));
    const bottom = Math.max(top + 2, Math.min(height, Math.max(normalized[1], normalized[3])));
    return [{ ...item, name: String(item?.title || item?.name || `区域 ${index + 1}`), type: item?.type === 'text' ? 'text' : 'ui',
      bbox: [left, top, right, bottom].map(Math.round), confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
      should_split: item?.type === 'text' ? false : item?.should_split !== false }];
  });
}

export function refineHeaderBoxes(boxes, refinements, width, height, cropHeight, space) {
  const result = boxes.map(box => ({ ...box }));
  const used = new Set();
  for (const refinement of Array.isArray(refinements) ? refinements : []) {
    const index = refinement?.box_index;
    if (!Number.isInteger(index) || !result[index] || used.has(index)) continue;
    const original = normalizeVisionBoxes([result[index]], width, height, space)[0];
    if (!original || (original.bbox[1] + original.bbox[3]) / 2 >= cropHeight) continue;
    const raw = refinement.bbox;
    if (!Array.isArray(raw) || raw.length !== 4 || raw.some(value => !Number.isFinite(value) || value < 0 || value > 999)
      || raw[2] <= raw[0] || raw[3] <= raw[1] || raw[3] >= 998) continue;
    const refined = normalizeVisionBoxes([{ ...result[index], bbox: raw }], width, cropHeight)[0];
    // Convert back to the full image's declared coordinate space before the final pass.
    const denominator = space === 'normalized_0_999' ? 999 : ['normalized_1000', '0_1000'].includes(space) ? 1000
      : ['normalized', 'normalized_01'].includes(space) ? 1 : null;
    result[index].bbox = denominator ? refined.bbox.map((value, i) => value / (i % 2 ? height : width) * denominator) : refined.bbox;
    used.add(index);
  }
  return result;
}

export async function runVisionBoxes({ image, instruction, apiKey, apiUrl, model }, request = fetch) {
  const source = await loadImage(Buffer.from(image.split(',')[1], 'base64'));
  const width = source.width, height = source.height;
  if (width < 2 || height < 2 || width * height > 32_000_000) throw new Error('自动框选图片尺寸无效或过大。');
  const cropHeight = height > width * 1.3 ? Math.ceil(height * .25) : 0;
  const safeInstruction = typeof instruction === 'string' ? instruction.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 4000) : '';
  const prompt = `识别图片中可独立编辑的游戏 UI 元素和程序文字，忽略背景、完整画布、装饰碎片、微小噪声和重复区域。图1是完整原图，像素尺寸 ${width}×${height}。以图1左上角为原点，不扣除顶部留白、安全区、状态栏，不估计界面内容的起点。bbox 顺序为 [左,上,右,下]，紧贴实际可见元素。标题简洁；程序文字 type=text 且 should_split=false，UI type=ui。${safeInstruction ? `用户补充范围要求：${safeInstruction}。` : ''}${cropHeight ? `图2是图1顶部的局部图，裁切范围为原图 [0,0,${width},${cropHeight}]，没有缩放或补边。请利用图2仔细校准头像、资源条、数字等顶部元素；不要把顶部留白包含进框。boxes 始终使用图1坐标。另在 header_refinements 返回完全显示在图2内的元素：box_index 引用 boxes 数组的零基索引，bbox 使用图2自身的 normalized_0_999 坐标。图2下边缘截断的元素不要校准。不新增重复元素。` : ''}只返回纯 JSON：{"coordinate_space":"normalized_0_999","boxes":[{"title":"名称","type":"ui|text","bbox":[x1,y1,x2,y2],"confidence":0.9,"should_split":true}],"header_refinements":[{"box_index":0,"bbox":[x1,y1,x2,y2]}]}。坐标使用整数0..999，999代表对应图片的右/下边缘。`;
  const content = [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }];
  if (cropHeight) {
    const canvas = createCanvas(width, cropHeight);
    canvas.getContext('2d').drawImage(source, 0, 0);
    content.push({ type: 'image_url', image_url: { url: canvas.toDataURL('image/png') } });
  }
  const upstream = await request(apiUrl, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: .1, messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(90_000) });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(data?.error?.message || data?.message || '视觉定位请求失败');
  const response = data?.choices?.[0]?.message?.content;
  const text = typeof response === 'string' ? response : Array.isArray(response) ? response.map(part => part?.text || '').join('') : '';
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('视觉模型未返回 JSON。');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed.boxes)) throw new Error('视觉模型未返回框选列表。');
  const space = String(parsed.coordinate_space || 'normalized_0_999').toLowerCase().replace(/[-\s]/g, '_');
  const refined = cropHeight ? refineHeaderBoxes(parsed.boxes, parsed.header_refinements, width, height, cropHeight, space) : parsed.boxes;
  const boxes = normalizeVisionBoxes(refined, width, height, space);
  const area = box => (box.bbox[2] - box.bbox[0]) * (box.bbox[3] - box.bbox[1]);
  const iou = (a, b) => {
    const intersection = Math.max(0, Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]))
      * Math.max(0, Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1]));
    return intersection / Math.max(1, area(a) + area(b) - intersection);
  };
  return { coordinate_space: 'pixel', boxes: boxes.filter(box => area(box) >= 16 && area(box) < width * height * .98)
    .sort((a, b) => b.confidence - a.confidence)
    .filter((box, index, list) => list.slice(0, index).every(previous => previous.type !== box.type || iou(previous, box) < .8))
    .map(box => ({ ...box, title: box.name })) };
}
