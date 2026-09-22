import type { DocumentState, LayerNode } from './types';

export type InsertPosition = 'before' | 'after';

export const toggleLayerSelection = (ids: string[], id: string) =>
  ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];

export const rangeLayerSelection = (
  visibleIds: string[],
  anchorId: string,
  clickedId: string,
) => {
  const anchorIndex = visibleIds.indexOf(anchorId);
  const clickedIndex = visibleIds.indexOf(clickedId);
  if (anchorIndex < 0 || clickedIndex < 0) return [clickedId];
  const start = Math.min(anchorIndex, clickedIndex);
  const end = Math.max(anchorIndex, clickedIndex);
  return visibleIds.slice(start, end + 1);
};

const descendantLayerIds = (layers: LayerNode[], parentIds: string[]) => {
  const result = new Set<string>();
  let frontier = [...parentIds];
  while (frontier.length) {
    const parents = new Set(frontier);
    frontier = layers
      .filter((layer) => layer.parentId && parents.has(layer.parentId))
      .map((layer) => layer.id)
      .filter((id) => !result.has(id));
    frontier.forEach((id) => result.add(id));
  }
  return result;
};

/** Removes descendants when their ancestor is already part of the moving batch. */
export const rootMovingLayerIds = (layers: LayerNode[], ids: string[]) => {
  const requested = new Set(ids);
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  return ids.filter((id) => {
    let parentId = byId.get(id)?.parentId;
    while (parentId) {
      if (requested.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId;
    }
    return true;
  });
};

export const reorderLayerBatch = (
  document: DocumentState,
  ids: string[],
  targetId: string,
  position: InsertPosition,
): DocumentState => {
  const movingIds = rootMovingLayerIds(document.layers, ids);
  if (!movingIds.length || movingIds.includes(targetId)) return document;
  const movingDescendants = descendantLayerIds(document.layers, movingIds);
  if (movingDescendants.has(targetId)) return document;

  const ordered = [...document.layers].sort((a, b) => a.zIndex - b.zIndex);
  const movingSet = new Set(movingIds);
  const moving = ordered.filter((layer) => movingSet.has(layer.id));
  const remaining = ordered.filter((layer) => !movingSet.has(layer.id));
  const targetIndex = remaining.findIndex((layer) => layer.id === targetId);
  if (targetIndex < 0) return document;

  const target = remaining[targetIndex];
  const insertionIndex = targetIndex + (position === 'after' ? 1 : 0);
  const inserted = moving.map((layer) => ({
    ...layer,
    parentId: target.parentId,
    artboardId: target.artboardId,
  }));
  const next = [...remaining];
  next.splice(insertionIndex, 0, ...inserted);
  const zById = new Map(next.map((layer, index) => [layer.id, index]));

  return {
    ...document,
    layers: document.layers.map((layer) => {
      const moved = inserted.find((item) => item.id === layer.id);
      return {
        ...(moved ?? layer),
        ...(movingDescendants.has(layer.id)
          ? { artboardId: target.artboardId }
          : {}),
        zIndex: zById.get(layer.id) ?? layer.zIndex,
      };
    }),
  };
};

export const assignLayerBatchToArtboard = (
  document: DocumentState,
  ids: string[],
  artboardId?: string,
): DocumentState => {
  const rootIds = rootMovingLayerIds(document.layers, ids);
  const movingIds = new Set([
    ...rootIds,
    ...descendantLayerIds(document.layers, rootIds),
  ]);
  if (!movingIds.size) return document;
  return {
    ...document,
    layers: document.layers.map((layer) =>
      movingIds.has(layer.id)
        ? {
            ...layer,
            artboardId,
            parentId: rootIds.includes(layer.id) ? null : layer.parentId,
          }
        : layer,
    ),
  };
};

/** Removes requested layers and every descendant of a selected group. */
export const removeLayerBatch = (
  document: DocumentState,
  ids: string[],
): DocumentState => {
  const rootIds = rootMovingLayerIds(document.layers, ids);
  const removedIds = new Set([
    ...rootIds,
    ...descendantLayerIds(document.layers, rootIds),
  ]);
  if (!removedIds.size) return document;
  return {
    ...document,
    layers: document.layers.filter((layer) => !removedIds.has(layer.id)),
  };
};
