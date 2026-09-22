import { readPsd } from 'ag-psd';
import type { DocumentState, LayerNode } from './types';

type PsdLayer = {
  name?: string;
  left?: number;
  top?: number;
  hidden?: boolean;
  opacity?: number;
  canvas?: HTMLCanvasElement;
  children?: PsdLayer[];
};

const uid = () => crypto.randomUUID().replaceAll('-', '');
const normalizedOpacity = (value: number | undefined) => value === undefined ? 1 : value > 1 ? value / 255 : value;

export async function importPsd(file: File): Promise<DocumentState> {
  const psd = readPsd(await file.arrayBuffer()) as { width: number; height: number; children?: PsdLayer[] };
  const layers: LayerNode[] = [];
  let zIndex = 0;
  const append = (items: PsdLayer[] | undefined, parentId: string | null) => {
    for (const item of items || []) {
      const id = uid();
      if (item.children) {
        layers.push({ id, name: item.name || '组', kind: 'group', parentId, x: 0, y: 0, width: 1, height: 1, zIndex: zIndex++, visible: !item.hidden, locked: false, opacity: normalizedOpacity(item.opacity) });
        append(item.children, id);
        continue;
      }
      if (!item.canvas) continue;
      layers.push({
        id, name: item.name || '图层', kind: 'image', parentId,
        x: item.left ?? 0, y: item.top ?? 0, width: item.canvas.width, height: item.canvas.height,
        assetWidth: item.canvas.width, assetHeight: item.canvas.height,
        zIndex: zIndex++, visible: !item.hidden, locked: false, opacity: normalizedOpacity(item.opacity),
        source: item.canvas.toDataURL('image/png'),
      });
    }
  };
  append(psd.children, null);
  if (!layers.some(layer => layer.kind === 'image')) throw new Error('该 PSD 没有可读取的栅格、文本或智能对象预览图层。');
  return { version: '1.0', canvas: { width: psd.width, height: psd.height }, artboards: [], layers };
}
