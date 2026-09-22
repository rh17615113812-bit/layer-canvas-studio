export type PixelBBox = [number, number, number, number];
export type NormalizedBBox = [number, number, number, number];

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
