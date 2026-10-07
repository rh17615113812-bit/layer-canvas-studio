import { createWorker, PSM } from 'tesseract.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const modelPath = fileURLToPath(new URL('./ocr-data/', import.meta.url));
let workerPromise;
let queue = Promise.resolve();

function estimateTextColor(ctx, bbox) {
  const left = Math.max(0, Math.floor(bbox.x0)), top = Math.max(0, Math.floor(bbox.y0));
  const width = Math.max(1, Math.min(ctx.canvas.width - left, Math.ceil(bbox.x1) - left));
  const height = Math.max(1, Math.min(ctx.canvas.height - top, Math.ceil(bbox.y1) - top));
  const pixels = ctx.getImageData(left, top, width, height).data;
  const bins = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    const key = `${pixels[i] >> 4},${pixels[i + 1] >> 4},${pixels[i + 2] >> 4}`;
    const bin = bins.get(key) || { count: 0, rgb: [0, 0, 0] };
    bin.count++; for (let c = 0; c < 3; c++) bin.rgb[c] += pixels[i + c];
    bins.set(key, bin);
  }
  const colors = [...bins.values()].map(bin => ({ count: bin.count, rgb: bin.rgb.map(value => Math.round(value / bin.count)) }));
  // The crop's corner supplies a background estimate; prioritize a frequent contrasting color.
  const corner = ctx.getImageData(Math.max(0, left - 1), Math.max(0, top - 1), 1, 1).data;
  const contrasting = colors.filter(color => color.rgb.reduce((sum, value, i) => sum + (value - corner[i]) ** 2, 0) > 90 ** 2);
  const foreground = contrasting.sort((a, b) => b.count - a.count)[0];
  return foreground ? `#${foreground.rgb.map(value => value.toString(16).padStart(2, '0')).join('')}` : '#000000';
}
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      for (const lang of ['chi_sim', 'eng']) {
        await access(`${modelPath}/${lang}.traineddata.gz`).catch(() => {
          throw new Error('本地 OCR 语言模型未安装，请运行 npm run setup:ocr。');
        });
      }
      const worker = await createWorker('chi_sim+eng', 1, {
        langPath: modelPath, cacheMethod: 'none', gzip: true, errorHandler: () => {},
      });
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, user_defined_dpi: '300' });
        return worker;
      } catch (error) { await worker.terminate(); throw error; }
    })().catch(error => { workerPromise = undefined; throw error; });
  }
  return workerPromise;
}

export function runLocalOcr({ image, width, height }) {
  // A single resident worker avoids loading both models for every selected box.
  const task = queue.then(async () => {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16_000_000) {
      throw new Error('OCR 图片尺寸无效或过大（最多 1600 万像素）。');
    }
    if (typeof image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(image)) throw new Error('OCR 需要本地图片。');
    const source = await loadImage(Buffer.from(image.split(',')[1], 'base64'));
    if (source.width !== width || source.height !== height) throw new Error('OCR 图片与声明尺寸不一致。');
    const scale = Math.max(1, Math.min(3, 1800 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height))));
    const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    const sample = createCanvas(64, 64), sampleCtx = sample.getContext('2d');
    sampleCtx.drawImage(source, 0, 0, 64, 64);
    const pixels = sampleCtx.getImageData(0, 0, 64, 64).data;
    let alphaSum = 0, lightSum = 0, hasTransparency = false;
    for (let i = 0; i < pixels.length; i += 4) {
      hasTransparency ||= pixels[i + 3] < 250;
      alphaSum += pixels[i + 3];
      lightSum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 * pixels[i + 3];
    }
    // White glyphs on transparency need a dark recognition background.
    ctx.fillStyle = hasTransparency && alphaSum && lightSum / alphaSum > 160 ? '#202020' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const sx = canvas.width / width, sy = canvas.height / height;
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas.toBuffer('image/png'), {}, { blocks: true });
    const lines = (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(paragraph => paragraph.lines || []));
    return {
      provider: 'local', coordinate_space: 'pixel',
      regions: lines.filter(line => line.text?.trim()).map(line => ({
        text: line.text.trim().replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1'),
        bbox: [line.bbox.x0 / sx, line.bbox.y0 / sy, line.bbox.x1 / sx, line.bbox.y1 / sy],
        style: { font_family: 'Microsoft YaHei', font_size: Math.max(8, (line.bbox.y1 - line.bbox.y0) / sy),
          color: estimateTextColor(ctx, line.bbox), bold: false, italic: false, align: 'left', vertical_align: 'top',
          line_height: 1.2, letter_spacing: 0, stroke_color: '#000000', stroke_width: 0 },
      })),
    };
  }).catch(error => { throw error instanceof Error ? error : new Error(String(error)); });
  queue = task.catch(() => undefined);
  return task;
}

export async function closeLocalOcr() {
  await queue;
  if (workerPromise) { const worker = await workerPromise; workerPromise = undefined; await worker.terminate(); }
}
