import { clampPixelBBox, normalizeOcrRegions, type OcrTextRegion, type PixelBBox } from './coordinates.ts';
import type { DocumentState, LayerNode } from './types';
import { fitTextLayer } from './textLayout.ts';

export type RecognizableBox = { id: string; name: string; type: 'ui' | 'text'; bbox: PixelBBox; ocrRegions?: OcrTextRegion[]; ocrBBox?: PixelBBox; ocrError?: string };
export const hasCurrentText = (box: RecognizableBox) => !!box.ocrRegions?.length &&
  box.bbox.every((value, index) => value === box.ocrBBox?.[index]);

export async function recognizeTextBox(source: string, box: RecognizableBox, provider: 'local' | 'cloud' | 'tencent' = 'local'): Promise<OcrTextRegion[]> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('无法读取文字源图片。')); image.src = source;
  });
  const bounded = clampPixelBBox(box.bbox, image.naturalWidth, image.naturalHeight);
  const left = Math.floor(bounded[0]), top = Math.floor(bounded[1]);
  const width = Math.ceil(bounded[2]) - left, height = Math.ceil(bounded[3]) - top;
  if (width <= 0 || height <= 0) throw new Error('文字框为空，请重新框选。');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(image, left, top, width, height, 0, 0, width, height);
  const response = await fetch('http://127.0.0.1:8787/api/vision/ocr', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, image: canvas.toDataURL('image/png'), metadata: { width, height } }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Error('文字识别接口不存在：API 服务可能仍为旧版本。请重启 npm run dev 后点击“重新识别”。');
  if (!response.ok) throw new Error(body.error || '文字识别失败。');
  const regions = normalizeOcrRegions(Array.isArray(body.regions) ? body.regions : [], width, height, body.coordinate_space)
    .map(region => ({ ...region, bbox: [region.bbox[0] + left, region.bbox[1] + top, region.bbox[2] + left, region.bbox[3] + top] as PixelBBox }));
  if (!regions.length) throw new Error('框内未识别到可读文字，请调整框选范围或重新识别。');
  return regions;
}

/** Pixel-space text assets shared by the original artboard and split comparison output. */
export function textLayersFromBoxes(boxes: RecognizableBox[]): LayerNode[] {
  return boxes.flatMap((box, index) => {
    if (box.type !== 'text') return [];
    if (!hasCurrentText(box)) throw new Error(`「${box.name}」尚未完成当前框的文字识别。`);
    return box.ocrRegions!.map((region, regionIndex) => fitTextLayer({
      id: crypto.randomUUID().replaceAll('-', ''), name: `${box.name || '程序文字'}${box.ocrRegions!.length > 1 ? ` · ${regionIndex + 1}` : ''}`,
      kind: 'text' as const, parentId: null, x: region.bbox[0], y: region.bbox[1],
      width: Math.max(1, region.bbox[2] - region.bbox[0]), height: Math.max(1, region.bbox[3] - region.bbox[1]),
      zIndex: boxes.length - index, visible: true, locked: false, opacity: 1,
      textContent: region.text, textStyle: { ...region.style },
    }));
  });
}

export function placeTextLayers(layers: LayerNode[], source: LayerNode, imageWidth: number, imageHeight: number): LayerNode[] {
  const sx = source.width / imageWidth, sy = source.height / imageHeight;
  const angle = (source.rotation || 0) * Math.PI / 180;
  return layers.map(layer => fitTextLayer({
    ...layer, artboardId: source.artboardId,
    x: source.x + layer.x * sx * Math.cos(angle) - layer.y * sy * Math.sin(angle),
    y: source.y + layer.x * sx * Math.sin(angle) + layer.y * sy * Math.cos(angle),
    width: layer.width * sx, height: layer.height * sy, rotation: source.rotation || 0,
    textStyle: scaleTextStyle(layer, sx, sy),
  }));
}

export function scaleTextStyle(layer: LayerNode, sx: number, sy: number) {
  if (layer.kind !== 'text') return layer.textStyle;
  const style = layer.textStyle ?? {};
  return { ...style, fontSize: Math.max(1, (style.fontSize ?? 24) * sy),
    letterSpacing: (style.letterSpacing ?? 0) * sx, strokeWidth: (style.strokeWidth ?? 0) * Math.min(sx, sy) };
}

/** Add editable text without touching image pixels or visibility. */
export function applyTextOverlay(document: DocumentState, sourceId: string, textLayers: LayerNode[]): DocumentState {
  const source = document.layers.find(layer => layer.id === sourceId);
  if (!source || !textLayers.length) return document;
  const baseZ = Math.max(0, ...document.layers.map(layer => layer.zIndex)) + 1;
  return { ...document, layers: [...document.layers,
    ...textLayers.map(layer => fitTextLayer({ ...layer, parentId: source.parentId, opacity: source.opacity ?? 1, zIndex: baseZ + layer.zIndex })),
  ] };
}
