import type { TextLayerStyle } from './types';

export type PixelBBox = [number, number, number, number];
export type NormalizedBBox = [number, number, number, number];
export type OcrTextRegion = { text: string; bbox: PixelBBox; style: TextLayerStyle };

/** Map pointer coordinates through the image's actual rendered bounds, including pan and CSS scaling. */
export function clientPointToImage(
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  imageWidth: number, imageHeight: number,
) {
  return {
    x: (clientX - rect.left) * imageWidth / Math.max(1, rect.width),
    y: (clientY - rect.top) * imageHeight / Math.max(1, rect.height),
  };
}

export const normalizeOcrRegions = (
  regions: unknown[],
  width: number,
  height: number,
  coordinateSpace = 'normalized_0_999',
): OcrTextRegion[] => regions.flatMap((raw): OcrTextRegion[] => {
  if (!raw || typeof raw !== 'object') return [];
  const item = raw as Record<string, unknown>;
  const values = Array.isArray(item.bbox) ? item.bbox.map(Number) : [];
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!text || values.length !== 4 || values.some(value => !Number.isFinite(value))) return [];
  const normalized = /normalized_0_999|0_1000|normalized_1000/i.test(coordinateSpace)
    ? [values[0] * width / 999, values[1] * height / 999, values[2] * width / 999, values[3] * height / 999]
    : /normalized|0_1/i.test(coordinateSpace)
      ? [values[0] * width, values[1] * height, values[2] * width, values[3] * height]
      : values;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const left = clamp(Math.min(normalized[0], normalized[2]), 0, Math.max(0, width - 1));
  const top = clamp(Math.min(normalized[1], normalized[3]), 0, Math.max(0, height - 1));
  const right = clamp(Math.max(normalized[0], normalized[2]), left + 1, width);
  const bottom = clamp(Math.max(normalized[1], normalized[3]), top + 1, height);
  const rawStyle = item.style && typeof item.style === 'object' ? item.style as Record<string, unknown> : item;
  const fontSize = Number(rawStyle.font_size ?? rawStyle.fontSize);
  const lineHeight = Number(rawStyle.line_height ?? rawStyle.lineHeight);
  const letterSpacing = Number(rawStyle.letter_spacing ?? rawStyle.letterSpacing);
  const strokeWidth = Number(rawStyle.stroke_width ?? rawStyle.strokeWidth);
  const align = rawStyle.align;
  const verticalAlign = rawStyle.vertical_align ?? rawStyle.verticalAlign;
  const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value) ? value : fallback;
  return [{
    text,
    bbox: [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)],
    style: {
      fontFamily: typeof rawStyle.font_family === 'string' ? rawStyle.font_family : typeof rawStyle.fontFamily === 'string' ? rawStyle.fontFamily : 'Arial',
      fontSize: clamp(Number.isFinite(fontSize) ? fontSize : Math.min(bottom - top, 24), 1, 512),
      color: color(rawStyle.color, '#ffffff'),
      bold: rawStyle.bold === true,
      italic: rawStyle.italic === true,
      align: align === 'center' || align === 'right' ? align : 'left',
      verticalAlign: verticalAlign === 'middle' || verticalAlign === 'bottom' ? verticalAlign : 'top',
      ...(Number.isFinite(lineHeight) ? { lineHeight: clamp(lineHeight, 0.5, 5) } : {}),
      ...(Number.isFinite(letterSpacing) ? { letterSpacing: clamp(letterSpacing, -10, 100) } : {}),
      strokeColor: color(rawStyle.stroke_color ?? rawStyle.strokeColor, '#000000'),
      strokeWidth: Number.isFinite(strokeWidth) ? clamp(strokeWidth, 0, 32) : 0,
    },
  }];
});

export const clampPixelBBox = (bbox: PixelBBox, width: number, height: number): PixelBBox => {
  const left = Math.max(0, Math.min(width, Math.min(bbox[0], bbox[2])));
  const top = Math.max(0, Math.min(height, Math.min(bbox[1], bbox[3])));
  const right = Math.max(left, Math.min(width, Math.max(bbox[0], bbox[2])));
  const bottom = Math.max(top, Math.min(height, Math.max(bbox[1], bbox[3])));
  return [left, top, right, bottom];
};

export const pixelToNormalizedBBox = (bbox: PixelBBox, width: number, height: number): NormalizedBBox => {
  const [left, top, right, bottom] = clampPixelBBox(bbox, width, height);
  return [left, top, right, bottom].map((value, index) => Math.max(0, Math.min(999, Math.round(value / (index % 2 === 0 ? width : height) * 1000)))) as NormalizedBBox;
};

export const normalizedToPixelBBox = (bbox: NormalizedBBox, width: number, height: number): PixelBBox => clampPixelBBox([
  bbox[0] / 1000 * width, bbox[1] / 1000 * height, bbox[2] / 1000 * width, bbox[3] / 1000 * height,
], width, height);
