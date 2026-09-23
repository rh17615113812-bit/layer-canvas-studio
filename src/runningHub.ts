import type { SmartSplitBox } from './SmartSplitWorkspace';
import { fitLocalAssetToBox } from './localComfy';
import type { LayerNode } from './types';
import { getOverlapMasksForBox, getOverlappingBoxGroups, zIndexForFrontToBackIndex } from './boxOverlap';

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

const cropDataUrl = (
  image: HTMLImageElement,
  box: [number, number, number, number],
  overlapMasks: [number, number, number, number][] = [],
) => {
  const [left, top, right, bottom] = box;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(right - left));
  canvas.height = Math.max(1, Math.round(bottom - top));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建 RunningHub 输入图片。');
  context.drawImage(image, left, top, right - left, bottom - top, 0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  for (const mask of overlapMasks) {
    context.fillRect(
      (mask[0] - left) * canvas.width / (right - left),
      (mask[1] - top) * canvas.height / (bottom - top),
      (mask[2] - mask[0]) * canvas.width / (right - left),
      (mask[3] - mask[1]) * canvas.height / (bottom - top),
    );
  }
  return canvas.toDataURL('image/png');
};

export async function runningHubLayerSplit(
  source: string,
  boxes: SmartSplitBox[],
  config: RunningHubConfig,
  groupingBoxes: SmartSplitBox[] = boxes,
): Promise<LayerNode[]> {
  if (!boxes.length) throw new Error('RunningHub 拆分需要先手动框选或使用 AI 自动框选。');
  const sourceImage = await loadImage(source);
  const overlapGroups = getOverlappingBoxGroups(groupingBoxes);
  const groupingIndexByBoxId = new Map(groupingBoxes.map((box, index) => [box.id, index]));
  const groupByBoxId = new Map(
    overlapGroups.flatMap(group => group.boxIds.map(id => [id, group] as const)),
  );
  const results: LayerNode[] = [];
  for (const [index, box] of boxes.entries()) {
    const groupingIndex = groupingIndexByBoxId.get(box.id) ?? index;
    const overlapMasks = getOverlapMasksForBox(groupingBoxes, groupingIndex);
    const response = await fetch('http://127.0.0.1:8787/api/runninghub/layer-split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: cropDataUrl(sourceImage, box.bbox, overlapMasks), config }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `RunningHub 工作流处理区域 ${index + 1} 失败。`);
    const outputSource = typeof body.imageUrl === 'string' ? body.imageUrl : '';
    if (!outputSource) throw new Error(`RunningHub 工作流未返回区域 ${index + 1} 的图片。`);
    const asset = await loadImage(outputSource);
    const placement = fitLocalAssetToBox({ width: asset.naturalWidth, height: asset.naturalHeight }, box.bbox);
    const overlapGroup = groupByBoxId.get(box.id);
    results.push({
      id: crypto.randomUUID().replaceAll('-', ''), name: `RunningHub · ${box.name || `区域 ${index + 1}`}`,
      kind: 'image', parentId: overlapGroup?.id ?? null, x: placement.x, y: placement.y, width: placement.width, height: placement.height,
      zIndex: zIndexForFrontToBackIndex(groupingBoxes.length, groupingIndex), visible: true, locked: false, opacity: 1, source: outputSource,
      assetWidth: asset.naturalWidth, assetHeight: asset.naturalHeight,
    });
  }
  const returnedBoxIds = new Set(boxes.map(box => box.id));
  const groups: LayerNode[] = overlapGroups
    .filter(group => group.boxIds.some(id => returnedBoxIds.has(id)))
    .map((group, index) => ({
    id: group.id,
    name: `RunningHub 重叠框组 ${index + 1}`,
    kind: 'group',
    parentId: null,
    x: group.bbox[0],
    y: group.bbox[1],
    width: group.bbox[2] - group.bbox[0],
    height: group.bbox[3] - group.bbox[1],
    zIndex: zIndexForFrontToBackIndex(groupingBoxes.length, group.firstIndex),
    visible: true,
    locked: false,
    boundsMode: 'manual',
  }));
  return [...groups, ...results];
}
