import { fitTextLayer } from './textLayout.ts';
import type { DocumentState, LayerNode } from './types';
import { createArtboardDocument, createGroupDocument } from './artboards.ts';

export type EngineLayer = Pick<LayerNode, 'id' | 'name' | 'kind' | 'parentId' | 'x' | 'y' | 'width' | 'height' | 'zIndex' | 'visible' | 'rotation' | 'opacity' | 'locked' | 'textContent' | 'textStyle'> & { asset?: string };
export type EngineLayout = { version: 1; name: string; width: number; height: number; layers: EngineLayer[] };

export function buildEngineLayout(document: DocumentState, artboardId?: string, groupId?: string): { output: DocumentState; layout: EngineLayout } {
  document = { ...document, layers: document.layers.map(fitTextLayer) };
  const output = groupId ? createGroupDocument(document, groupId) : createArtboardDocument(document, artboardId);
  const artboard = output.artboards[0];
  const supported = output.layers.filter(layer => layer.kind === 'group' || layer.kind === 'image' && !!layer.source || layer.kind === 'text');
  const ids = new Set(supported.map(layer => layer.id));
  const layers = supported.map(layer => ({
    id: layer.id, name: layer.name, kind: layer.kind, parentId: layer.parentId && ids.has(layer.parentId) ? layer.parentId : null,
    x: layer.x, y: layer.y, width: layer.width, height: layer.height, zIndex: layer.zIndex,
    visible: layer.visible, rotation: layer.rotation ?? 0, opacity: layer.opacity ?? 1, locked: layer.locked,
    ...(layer.kind === 'text' ? { textContent: layer.textContent ?? '', textStyle: layer.textStyle } : {}),
    ...(layer.kind === 'image' ? { asset: `images/${encodeURIComponent(layer.id)}.png` } : {}),
  }));
  return { output, layout: { version: 1, name: artboard.name, width: artboard.width, height: artboard.height, layers } };
}

export function orderedEngineLayers(layout: EngineLayout): EngineLayer[] {
  const children = new Map<string | null, EngineLayer[]>();
  for (const layer of layout.layers) children.set(layer.parentId ?? null, [...(children.get(layer.parentId ?? null) ?? []), layer]);
  const result: EngineLayer[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null) => {
    for (const layer of (children.get(parent) ?? []).sort((a, b) => a.zIndex - b.zIndex)) {
      if (visited.has(layer.id)) continue;
      visited.add(layer.id); result.push(layer);
      walk(layer.id);
    }
  };
  walk(null);
  return result;
}

export function hasInterleavedGroups(layout: EngineLayout): boolean {
  const byId = new Map(layout.layers.map(layer => [layer.id, layer]));
  const draw = [...layout.layers].filter(layer => layer.kind !== 'group').sort((a, b) => a.zIndex - b.zIndex);
  return layout.layers.filter(layer => layer.kind === 'group').some(group => {
    const descendantIndices = draw.flatMap((layer, index) => {
      let parentId = layer.parentId;
      while (parentId) {
        if (parentId === group.id) return [index];
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      return [];
    });
    return descendantIndices.length > 1 && Math.max(...descendantIndices) - Math.min(...descendantIndices) + 1 !== descendantIndices.length;
  });
}
