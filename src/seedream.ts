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
const dimensions = (size: string | undefined, fallbackWidth: number, fallbackHeight: number) => {
  const [width, height] = (size || '').split('x').map(Number);
  return { width: Number.isFinite(width) ? width : fallbackWidth, height: Number.isFinite(height) ? height : fallbackHeight };
};
const placement = (item: ApiLayer, fallbackWidth: number, fallbackHeight: number) => {
  const absolute = absoluteBounds(item);
  if (absolute) { const [left, top, right, bottom] = absolute; return { x: left, y: top, width: Math.max(2, right - left), height: Math.max(2, bottom - top) }; }
  return { x: 0, y: 0, ...dimensions(item.size, fallbackWidth, fallbackHeight) };
};
const absoluteBounds = (item: ApiLayer) => Array.isArray(item.bounding_box) ? item.bounding_box : item.bounding_box?.absolute;
const sourceDimensions = async (source: string) => new Promise<{ width: number; height: number }>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
  image.onerror = () => reject(new Error('无法读取 AI 返回的图层图片尺寸。'));
  image.src = source;
});
const cropFullCanvasLayer = async (source: string, bounds: [number, number, number, number]) => new Promise<string>((resolve, reject) => {
  const image = new Image();
  image.onload = () => {
    const [left, top, right, bottom] = bounds;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, right - left); canvas.height = Math.max(1, bottom - top);
    canvas.getContext('2d')!.drawImage(image, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    resolve(canvas.toDataURL('image/png'));
  };
  image.onerror = () => reject(new Error('无法裁切 AI 返回的透明图层。'));
  image.src = source;
});

export async function seedreamLayerSplit(image: string, width: number, height: number, prompt?: string, metadata?: unknown): Promise<LayerNode[]> {
  const response = await fetch('http://127.0.0.1:8787/api/seedream/layer-split', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, prompt, metadata }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Seedream 图层拆分失败');
  // 官方响应 data 为扁平数组：z_index=0 是底图，其余条目为透明 PNG 图层。
  const items = collectItems(body);
  const layers = await Promise.all(items.map(async (item, index): Promise<LayerNode | undefined> => {
    const rawSource = dataUrl(item);
    if (!rawSource) return undefined;
    const box = placement(item, width, height), bounds = absoluteBounds(item);
    const rawAsset = await sourceDimensions(rawSource);
    // 部分响应返回“全画布透明 PNG”，有效内容位置由 bounding_box 描述；先无损裁切，避免再次缩放整张透明画布。
    const shouldCrop = Boolean(bounds && rawAsset.width >= bounds[2] && rawAsset.height >= bounds[3] && (rawAsset.width > box.width + 1 || rawAsset.height > box.height + 1));
    const source = shouldCrop ? await cropFullCanvasLayer(rawSource, bounds!) : rawSource;
    const asset = shouldCrop ? { width: box.width, height: box.height } : rawAsset;
    return {
      id: crypto.randomUUID().replaceAll('-', ''), name: item.z_index === 0 ? 'AI 拆分底图' : item.name || item.description || `AI 图层 ${index + 1}`,
      kind: 'image' as const, parentId: null, zIndex: item.z_index ?? index, visible: true, locked: false, opacity: 1, source,
      assetWidth: asset.width, assetHeight: asset.height, ...box,
    };
  })).then(results => results.filter((layer): layer is LayerNode => Boolean(layer)));
  if (!layers.length) {
    const shape = body && typeof body === 'object' ? Object.keys(body as Record<string, unknown>).join('、') || '空对象' : typeof body;
    throw new Error(`接口已返回成功，但未找到可用图层图片（响应字段：${shape}）。`);
  }
  return layers.sort((a, b) => a.zIndex - b.zIndex);
}
