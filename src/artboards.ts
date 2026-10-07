import type { Artboard, DocumentState, LayerNode } from './types';

export const ARTBOARD_GAP = 120;

export const artboardForLayer = (document: DocumentState, layer?: LayerNode) =>
  document.artboards.find(artboard => artboard.id === layer?.artboardId) ?? document.artboards[0];

export const nextArtboardOrigin = (artboards: Artboard[]) => ({
  x: artboards.length ? Math.max(...artboards.map(artboard => artboard.x + artboard.width)) + ARTBOARD_GAP : 0,
  y: 0,
});

export const fitArtboardView = (
  artboard: Pick<Artboard, 'x' | 'y' | 'width' | 'height'>,
  viewport: { width: number; height: number },
) => {
  const z = Math.min(Math.max(1, viewport.width - 140) / artboard.width, Math.max(1, viewport.height - 140) / artboard.height, 1);
  return {
    z,
    x: (viewport.width - artboard.width * z) / 2 - artboard.x * z,
    y: (viewport.height - artboard.height * z) / 2 - artboard.y * z,
  };
};

export const layerToArtboardCoordinates = (layer: LayerNode, artboard: Artboard) => ({
  x: layer.x - artboard.x,
  y: layer.y - artboard.y,
});

export const documentBounds = (artboards: Artboard[]) => ({
  width: Math.max(1, ...artboards.map(artboard => artboard.x + artboard.width)),
  height: Math.max(1, ...artboards.map(artboard => artboard.y + artboard.height)),
});

export const layersForArtboard = (document: DocumentState, artboardId: string) =>
  document.layers.filter(layer => layer.artboardId === artboardId);

export const artboardContainingPoint = (document: DocumentState, x: number, y: number) =>
  [...document.artboards].reverse().find(artboard => x >= artboard.x && x <= artboard.x + artboard.width && y >= artboard.y && y <= artboard.y + artboard.height);

export const createArtboardDocument = (document: DocumentState, artboardId?: string): DocumentState => {
  const artboard = document.artboards.find(item => item.id === artboardId) ?? document.artboards[0];
  if (!artboard) throw new Error('当前 Page 中没有可导出的画板。');
  return {
    ...document,
    canvas: { width: artboard.width, height: artboard.height },
    artboards: [{ ...artboard, x: 0, y: 0 }],
    layers: document.layers.filter(layer => layer.artboardId === artboard.id).map(layer => ({ ...layer, x: layer.x - artboard.x, y: layer.y - artboard.y })),
  };
};

export const createGroupDocument = (document: DocumentState, groupId: string): DocumentState => {
  const group = document.layers.find(layer => layer.id === groupId && layer.kind === 'group');
  if (!group) throw new Error('当前没有可导出的图层组。');
  const collect = (parentId: string): LayerNode[] =>
    document.layers
      .filter(layer => layer.parentId === parentId)
      .flatMap(layer => [layer, ...(layer.kind === 'group' ? collect(layer.id) : [])]);
  const artboardId = `group-${group.id}`;
  return {
    version: document.version,
    canvas: { width: group.width, height: group.height },
    artboards: [{ id: artboardId, name: group.name, x: 0, y: 0, width: group.width, height: group.height }],
    layers: collect(group.id).map(layer => ({
      ...layer,
      artboardId,
      parentId: layer.parentId === group.id ? null : layer.parentId,
      x: layer.x - group.x,
      y: layer.y - group.y,
      visible: layer.visible && group.visible,
    })),
  };
};

export const translateArtboard = (document: DocumentState, artboardId: string, dx: number, dy: number): DocumentState => {
  const artboards = document.artboards.map(artboard => artboard.id === artboardId ? { ...artboard, x: artboard.x + dx, y: artboard.y + dy } : artboard);
  return {
    ...document,
    canvas: documentBounds(artboards),
    artboards,
    layers: document.layers.map(layer => layer.artboardId === artboardId ? { ...layer, x: layer.x + dx, y: layer.y + dy } : layer),
  };
};

export const resizeArtboard = (
  document: DocumentState,
  artboardId: string,
  bounds: Pick<Artboard, 'x' | 'y' | 'width' | 'height'>,
): DocumentState => {
  const artboards = document.artboards.map(artboard => artboard.id === artboardId ? {
    ...artboard,
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(32, Math.round(bounds.width)),
    height: Math.max(32, Math.round(bounds.height)),
  } : artboard);
  return { ...document, canvas: documentBounds(artboards), artboards };
};

/** Removes an artboard together with all layers assigned to it. */
export const removeArtboard = (
  document: DocumentState,
  artboardId: string,
): DocumentState => {
  const artboards = document.artboards.filter(
    (artboard) => artboard.id !== artboardId,
  );
  if (artboards.length === document.artboards.length) return document;
  return {
    ...document,
    canvas: documentBounds(artboards),
    artboards,
    layers: document.layers.filter((layer) => layer.artboardId !== artboardId),
  };
};

export const assignLayerToArtboard = (
  document: DocumentState,
  layerId: string,
  artboardId?: string,
): DocumentState => {
  const collect = (parentId: string): string[] =>
    document.layers
      .filter(layer => layer.parentId === parentId)
      .flatMap(layer => [layer.id, ...collect(layer.id)]);
  const movingIds = new Set([layerId, ...collect(layerId)]);
  return {
    ...document,
    layers: document.layers.map(layer => movingIds.has(layer.id) ? {
      ...layer,
      artboardId,
      parentId: layer.id === layerId ? null : layer.parentId,
    } : layer),
  };
};
