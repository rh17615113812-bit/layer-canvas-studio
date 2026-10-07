import type { LayerNode } from './types';

export const normalizedOpacity = (value = 1) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;

export function layerTransform(x: number, y: number, rotation = 0): [number, number, number, number, number, number] {
  const angle = rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [cos, sin, -sin, cos, x, y];
}

export function rotatedGeometry(x: number, y: number, width: number, height: number, rotation = 0) {
  const [a, b, c, d] = layerTransform(x, y, rotation);
  const points = [[0, 0], [width, 0], [width, height], [0, height]].map(([px, py]) => [x + a * px + c * py, y + b * px + d * py]);
  // Avoid extra pixels caused by floating point errors at right angles.
  const clean = (v: number) => Math.abs(v - Math.round(v)) < 1e-8 ? Math.round(v) : v;
  const left = Math.floor(clean(Math.min(...points.map(p => p[0]))));
  const top = Math.floor(clean(Math.min(...points.map(p => p[1]))));
  const right = Math.ceil(clean(Math.max(...points.map(p => p[0]))));
  const bottom = Math.ceil(clean(Math.max(...points.map(p => p[1]))));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top), quad: points.flat() };
}

export function rasterizeRotation(source: HTMLCanvasElement, x: number, y: number, rotation = 0) {
  const bounds = rotatedGeometry(x, y, source.width, source.height, rotation);
  const canvas = document.createElement('canvas');
  canvas.width = bounds.width; canvas.height = bounds.height;
  const context = canvas.getContext('2d')!;
  context.setTransform(...layerTransform(x - bounds.left, y - bounds.top, rotation));
  context.drawImage(source, 0, 0);
  return { canvas, ...bounds };
}

/** Render a workspace selection, including moved, scaled and rotated source layers. */
export function extractSelectionCanvas(image: CanvasImageSource, source: Pick<LayerNode, 'x' | 'y' | 'width' | 'height' | 'rotation'>, selection: Pick<LayerNode, 'x' | 'y' | 'width' | 'height'>) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(selection.width));
  canvas.height = Math.max(1, Math.round(selection.height));
  const context = canvas.getContext('2d')!;
  context.setTransform(...layerTransform(source.x - selection.x, source.y - selection.y, source.rotation));
  context.drawImage(image, 0, 0, source.width, source.height);
  return canvas;
}
