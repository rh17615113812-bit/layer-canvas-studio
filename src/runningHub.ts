import type { SmartSplitBox } from './SmartSplitWorkspace';
import { fitLocalAssetToBox } from './localComfy';
import type { LayerNode } from './types';

export type RunningHubConfig = {
  workflowId?: string;
  inputNodeId?: string;
  inputFieldName?: string;
  outputNodeIds?: string[];
  instanceType?: 'default' | 'plus' | 'ultra';
  addMetadata?: boolean;
  usePersonalQueue?: boolean;
};

const loadImage = (source: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('无法读取 RunningHub 拆分图片。'));
  image.src = source;
});

const cropDataUrl = (image: HTMLImageElement, box: [number, number, number, number]) => {
  const [left, top, right, bottom] = box;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(right - left));
  canvas.height = Math.max(1, Math.round(bottom - top));
  canvas.getContext('2d')!.drawImage(image, left, top, right - left, bottom - top, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
};

export async function runningHubLayerSplit(source: string, boxes: SmartSplitBox[], config: RunningHubConfig): Promise<LayerNode[]> {
  if (!boxes.length) throw new Error('RunningHub 拆分需要先手动框选或使用 AI 自动框选。');
  const sourceImage = await loadImage(source);
  const results: LayerNode[] = [];
  for (const [index, box] of boxes.entries()) {
    const response = await fetch('http://127.0.0.1:8787/api/runninghub/layer-split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: cropDataUrl(sourceImage, box.bbox), config }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `RunningHub 工作流处理区域 ${index + 1} 失败。`);
    const outputSource = typeof body.imageUrl === 'string' ? body.imageUrl : '';
    if (!outputSource) throw new Error(`RunningHub 工作流未返回区域 ${index + 1} 的图片。`);
    const asset = await loadImage(outputSource);
    const placement = fitLocalAssetToBox({ width: asset.naturalWidth, height: asset.naturalHeight }, box.bbox);
    results.push({
      id: crypto.randomUUID().replaceAll('-', ''), name: `RunningHub · ${box.name || `区域 ${index + 1}`}`,
      kind: 'image', parentId: null, x: placement.x, y: placement.y, width: placement.width, height: placement.height,
      zIndex: index, visible: true, locked: false, opacity: 1, source: outputSource,
      assetWidth: asset.naturalWidth, assetHeight: asset.naturalHeight,
    });
  }
  return results;
}
