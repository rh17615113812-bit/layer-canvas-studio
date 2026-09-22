import type { LayerNode } from './types';

type ApiLayer = {
  name?: string; description?: string; z_index?: number; size?: string; url?: string; image_url?: string; b64_json?: string; base64?: string;
  image?: { url?: string; image_url?: string; b64_json?: string; base64?: string } | string;
  bounding_box?: { absolute?: [number, number, number, number]; normalized?: [number, number, number, number] } | [number, number, number, number];
};
const dataUrl = (item: ApiLayer) => {
  const nested = typeof item.image === 'string' ? { url: item.image } : item.image;
  const base64 = item.b64_json || item.base64 || nested?.b64_json || nested?.base64;
  return base64 ? `data:image/png;base64,${base64}` : item.url || item.image_url || nested?.url || nested?.image_url;
};
const collectItems = (body: unknown): ApiLayer[] => {
  const value = body as Record<string, unknown> | undefined;
  const candidates = [value?.data, value?.layers, value?.images, value?.outputs, value?.result, value?.result && (value.result as Record<string, unknown>).data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as ApiLayer[];
    if (candidate && typeof candidate === 'object') {
      const nested = candidate as Record<string, unknown>;
      for (const key of ['layers', 'images', 'outputs', 'data']) if (Array.isArray(nested[key])) return nested[key] as ApiLayer[];
    }
  }
  return [];
};
const absoluteBounds = (item: ApiLayer, baseSize: Size) => {
  if (Array.isArray(item.bounding_box)) return item.bounding_box;
  if (item.bounding_box?.absolute) return item.bounding_box.absolute;
  if (!item.bounding_box?.normalized) return undefined;
  const [left, top, right, bottom] = item.bounding_box.normalized;
  return [left * baseSize.width / 1000, top * baseSize.height / 1000, right * baseSize.width / 1000, bottom * baseSize.height / 1000] as Bounds;
};
type Size = { width: number; height: number };
type Rect = Size & { x: number; y: number };
type Bounds = [number, number, number, number];

export const placeAssetInComposite = (bounds: Bounds | undefined, baseSize: Size, targetSize: Size): Rect => {
  if (!bounds) return { x: 0, y: 0, width: targetSize.width, height: targetSize.height };
  const scaleX = targetSize.width / baseSize.width, scaleY = targetSize.height / baseSize.height;
  const [left, top, right, bottom] = bounds;
  return {
    x: left * scaleX,
    y: top * scaleY,
    width: Math.max(1, (right - left) * scaleX),
    height: Math.max(1, (bottom - top) * scaleY),
  };
};
const sourceDimensions = async (source: string) => new Promise<{ width: number; height: number }>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
  image.onerror = () => reject(new Error('无法读取 AI 返回的图层图片尺寸。'));
  image.src = source;
});

export async function seedreamLayerSplit(image: string, width: number, height: number, prompt?: string, metadata?: unknown): Promise<LayerNode[]> {
  const response = await fetch('http://127.0.0.1:8787/api/seedream/layer-split', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, prompt, metadata }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Seedream 图层拆分失败');
  // 官方响应 data 为扁平数组：z_index=0 是底图，其余条目为透明 PNG 图层。
  const items = collectItems(body);
  const prepared = await Promise.all(items.map(async (item, index) => {
    const rawSource = dataUrl(item);
    if (!rawSource) return undefined;
    const rawAsset = await sourceDimensions(rawSource);
    return { item, index, rawSource, rawAsset };
  })).then(results => results.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)));
  const base = prepared.find(entry => entry.item.z_index === 0) || prepared.find(entry => !itemHasBounds(entry.item)) || prepared[0];
  const baseSize = base?.rawAsset || { width, height };
  const targetSize = { width, height };
  const layers = prepared.map(({ item, index, rawSource, rawAsset }): LayerNode => {
    // PNG 始终完整保留；bounding_box 定义它在基础输出图坐标系中的显示矩形。
    // 再把整套坐标统一映射回输入原图尺寸，复现官方预览的 1:1 合成效果。
    const box = placeAssetInComposite(item.z_index === 0 ? undefined : absoluteBounds(item, baseSize), baseSize, targetSize);
    return {
      id: crypto.randomUUID().replaceAll('-', ''), name: item.z_index === 0 ? 'AI 拆分底图' : item.name || item.description || `AI 图层 ${index + 1}`,
      kind: 'image' as const, parentId: null, zIndex: item.z_index ?? index, visible: true, locked: false, opacity: 1, source: rawSource,
      assetWidth: rawAsset.width, assetHeight: rawAsset.height, ...box,
    };
  });
  if (!layers.length) {
    const shape = body && typeof body === 'object' ? Object.keys(body as Record<string, unknown>).join('、') || '空对象' : typeof body;
    throw new Error(`接口已返回成功，但未找到可用图层图片（响应字段：${shape}）。`);
  }
  return layers.sort((a, b) => a.zIndex - b.zIndex);
}

function itemHasBounds(item: ApiLayer) {
  return Array.isArray(item.bounding_box) || Boolean(item.bounding_box?.absolute || item.bounding_box?.normalized);
}
