import type { SmartSplitBox } from './SmartSplitWorkspace';
import type { LayerNode } from './types';

export type LocalComfyConfig = {
  comfyUrl: string;
  workflow?: Record<string, unknown>;
  inputNodeId?: string;
  outputNodeIds?: string[];
};

type Size = { width: number; height: number };
type Box = [number, number, number, number];

export const fitLocalAssetToBox = (asset: Size, box: Box) => {
  const [left, top, right, bottom] = box;
  const boxWidth = Math.max(1, right - left);
  const boxHeight = Math.max(1, bottom - top);
  const scale = Math.min(boxWidth / Math.max(1, asset.width), boxHeight / Math.max(1, asset.height));
  const width = Math.max(1, asset.width * scale);
  const height = Math.max(1, asset.height * scale);
  return {
    x: left + (boxWidth - width) / 2,
    y: top + (boxHeight - height) / 2,
    width,
    height,
  };
};

const loadImage = (source: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取本地拆分图片。'));
    image.src = source;
  });

const cropDataUrl = (image: HTMLImageElement, box: Box) => {
  const [left, top, right, bottom] = box;
  const width = Math.max(1, Math.round(right - left));
  const height = Math.max(1, Math.round(bottom - top));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(
    image,
    left,
    top,
    right - left,
    bottom - top,
    0,
    0,
    width,
    height,
  );
  return canvas.toDataURL('image/png');
};

const dimensions = (source: string) =>
  loadImage(source).then(image => ({ width: image.naturalWidth, height: image.naturalHeight }));

export async function localComfyLayerSplit(
  source: string,
  boxes: SmartSplitBox[],
  config: LocalComfyConfig,
): Promise<LayerNode[]> {
  if (!boxes.length) throw new Error('本地拆分需要先手动框选或使用 AI 自动框选。');
  const image = await loadImage(source);
  const results: LayerNode[] = [];

  // Run one crop at a time. A ComfyUI result has no placement metadata, so every
  // returned bitmap is fitted back into the exact box that produced its crop.
  for (const [index, box] of boxes.entries()) {
    const response = await fetch('http://127.0.0.1:8787/api/comfyui/layer-split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: cropDataUrl(image, box.bbox),
        comfyUrl: config.comfyUrl,
        workflow: config.workflow,
        inputNodeId: config.inputNodeId,
        outputNodeIds: config.outputNodeIds,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `本地工作流处理区域 ${index + 1} 失败。`);
    const item = Array.isArray(body.images) ? body.images[0] : undefined;
    const outputSource = item?.base64
      ? `data:${item.mime || 'image/png'};base64,${item.base64}`
      : item?.url;
    if (!outputSource) throw new Error(`本地工作流未返回区域 ${index + 1} 的图片。`);
    const asset = await dimensions(outputSource);
    const placement = fitLocalAssetToBox(asset, box.bbox);
    results.push({
      id: crypto.randomUUID().replaceAll('-', ''),
      name: `本地 · ${box.name || `区域 ${index + 1}`}`,
      kind: 'image',
      parentId: null,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      zIndex: index,
      visible: true,
      locked: false,
      opacity: 1,
      source: outputSource,
      assetWidth: asset.width,
      assetHeight: asset.height,
    });
  }
  return results;
}
