export type BoxRect = [number, number, number, number];

export type BoxGeometry = {
  id: string;
  bbox: BoxRect;
  type?: 'ui' | 'text';
};

/** Default front-to-back order: smaller boxes stay above larger boxes. */
export const orderBoxesByDefaultStacking = <T extends BoxGeometry>(boxes: T[]): T[] =>
  boxes
    .map((box, index) => ({ box, index, area: Math.max(0, box.bbox[2] - box.bbox[0]) * Math.max(0, box.bbox[3] - box.bbox[1]) }))
    .sort((a, b) => a.area - b.area || a.index - b.index)
    .map(item => item.box);

/** This document draws larger zIndex values in front; convert front-to-back indexes. */
export const zIndexForFrontToBackIndex = (count: number, index: number) => Math.max(0, count - 1 - index);

export type OverlapGroup = {
  id: string;
  boxIds: string[];
  bbox: BoxRect;
  firstIndex: number;
};

export const reorderGroupMembers = (
  boxIds: string[],
  sourceBoxId: string,
  targetBoxId: string,
  placement: 'before' | 'after',
): string[] => {
  if (sourceBoxId === targetBoxId || !boxIds.includes(sourceBoxId) || !boxIds.includes(targetBoxId)) return boxIds;
  const reordered = boxIds.filter(id => id !== sourceBoxId);
  const targetIndex = reordered.indexOf(targetBoxId);
  reordered.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, sourceBoxId);
  return reordered;
};

const intersection = (a: BoxRect, b: BoxRect): BoxRect | null => {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[2], b[2]);
  const bottom = Math.min(a[3], b[3]);
  return right > left && bottom > top ? [left, top, right, bottom] : null;
};

export const getOverlapMasksForBox = (
  boxes: BoxGeometry[],
  index: number,
): BoxRect[] => {
  const current = boxes[index];
  if (!current) return [];
  // Box order is front to back: only earlier boxes cover the current box.
  return boxes
    .slice(0, index)
    .filter(box => box.type !== 'text')
    .map((box) => intersection(current.bbox, box.bbox))
    .filter((region): region is BoxRect => region !== null);
};

export const getOverlappingBoxGroups = (
  boxes: BoxGeometry[],
): OverlapGroup[] => {
  const neighbors = boxes.map((): number[] => []);
  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
      if (intersection(boxes[leftIndex].bbox, boxes[rightIndex].bbox)) {
        neighbors[leftIndex].push(rightIndex);
        neighbors[rightIndex].push(leftIndex);
      }
    }
  }

  const visited = new Set<number>();
  const groups: OverlapGroup[] = [];
  for (let index = 0; index < boxes.length; index += 1) {
    if (visited.has(index) || !neighbors[index].length) continue;
    const pending = [index];
    const memberIndexes: number[] = [];
    visited.add(index);
    while (pending.length) {
      const current = pending.pop()!;
      memberIndexes.push(current);
      for (const neighbor of neighbors[current]) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    memberIndexes.sort((a, b) => a - b);
    const members = memberIndexes.map((memberIndex) => boxes[memberIndex]);
    const left = Math.min(...members.map((box) => box.bbox[0]));
    const top = Math.min(...members.map((box) => box.bbox[1]));
    const right = Math.max(...members.map((box) => box.bbox[2]));
    const bottom = Math.max(...members.map((box) => box.bbox[3]));
    groups.push({
      id: `overlap-${members[0].id}`,
      boxIds: members.map((box) => box.id),
      bbox: [left, top, right, bottom],
      firstIndex: memberIndexes[0],
    });
  }
  return groups.sort((a, b) => a.firstIndex - b.firstIndex);
};
