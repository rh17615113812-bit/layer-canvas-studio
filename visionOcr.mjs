export async function runVisionOcr({ image, width, height, apiKey, apiUrl, model }, request = fetch) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('文字识别图片尺寸无效。');
  const prompt = `识别这张框选图片中的真实文字，图片像素尺寸 width=${width}, height=${height}。按连续文本段返回原文，保留标点、数字和换行，不改写、不补全文字，不把图标猜成字。每个文本段给出包围文字的 bbox 和近似样式。bbox 为相对于这张框选图片的整数 0..999 坐标，字体大小、字距、描边宽度使用该图片的像素单位。字体不确定时用 Arial。没有可读文字返回空 regions。只返回 JSON：{"coordinate_space":"normalized_0_999","regions":[{"text":"原文","bbox":[x1,y1,x2,y2],"style":{"font_family":"Arial","font_size":24,"color":"#ffffff","bold":false,"italic":false,"align":"left","vertical_align":"top","line_height":1.2,"letter_spacing":0,"stroke_color":"#000000","stroke_width":0}}]}。`;
  const response = await request(apiUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }] }] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || body?.message || '文字识别请求失败。');
  const content = body?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text || '').join('') : '';
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('文字识别未返回有效 JSON。');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed.regions)) throw new Error('文字识别结果缺少 regions。');
  return { coordinate_space: typeof parsed.coordinate_space === 'string' ? parsed.coordinate_space : 'normalized_0_999', regions: parsed.regions };
}
