import assert from 'node:assert/strict';
import { clampPixelBBox, normalizedToPixelBBox, pixelToNormalizedBBox } from '../src/coordinates.ts';
import { DEFAULT_VISION_INSTRUCTION, selectSplittableBoxes } from '../src/smartSplit.ts';
import { placeAssetInComposite } from '../src/seedream.ts';
import { assignLayerToArtboard, artboardContainingPoint, createArtboardDocument, createGroupDocument, layerToArtboardCoordinates, nextArtboardOrigin, removeArtboard, resizeArtboard, translateArtboard } from '../src/artboards.ts';
import { assignLayerBatchToArtboard, rangeLayerSelection, removeLayerBatch, reorderLayerBatch, rootMovingLayerIds, toggleLayerSelection } from '../src/layerOrder.ts';
import { fitLocalAssetToBox } from '../src/localComfy.ts';

assert.deepEqual(pixelToNormalizedBBox([0, 0, 100, 200], 100, 200), [0, 0, 999, 999]);
assert.deepEqual(normalizedToPixelBBox([0, 0, 999, 999], 100, 200), [0, 0, 99.9, 199.8]);
assert.deepEqual(clampPixelBBox([-10, 3, 150, 250], 100, 200), [0, 3, 100, 200]);
const source: [number, number, number, number] = [12, 24, 780, 460];
const roundTrip = normalizedToPixelBBox(pixelToNormalizedBBox(source, 800, 500), 800, 500);
assert.ok(Math.max(...source.map((value, index) => Math.abs(value - roundTrip[index]))) <= 1);
console.log('coordinate tests passed');
assert.match(DEFAULT_VISION_INSTRUCTION, /UI/);
assert.deepEqual(selectSplittableBoxes([{ type: 'ui' }, { type: 'ui', shouldSplit: false }, { type: 'text', shouldSplit: true }]), [{ type: 'ui' }]);
console.log('smart split routing tests passed');

assert.deepEqual(placeAssetInComposite(undefined, { width: 2048, height: 1024 }, { width: 1024, height: 512 }), { x: 0, y: 0, width: 1024, height: 512 });
assert.deepEqual(placeAssetInComposite([700, 460, 1340, 760], { width: 2048, height: 2048 }, { width: 2048, height: 2048 }), { x: 700, y: 460, width: 640, height: 300 });
assert.deepEqual(placeAssetInComposite([10, 20, 110, 70], { width: 2048, height: 1024 }, { width: 1024, height: 512 }), { x: 5, y: 10, width: 50, height: 25 });
console.log('seedream composite placement tests passed');

assert.deepEqual(nextArtboardOrigin([{ id: 'a', name: 'A', x: 80, y: 20, width: 1170, height: 2532 }]), { x: 1370, y: 0 });
assert.deepEqual(layerToArtboardCoordinates({ id: 'l', name: 'L', kind: 'image', parentId: null, artboardId: 'a', x: 210, y: 330, width: 10, height: 20, zIndex: 1, visible: true, locked: false }, { id: 'a', name: 'A', x: 200, y: 300, width: 1170, height: 2532 }), { x: 10, y: 30 });
console.log('artboard coordinate tests passed');

const exportedBoard = createArtboardDocument({
  version: '1.0', canvas: { width: 2500, height: 1200 },
  artboards: [{ id: 'a', name: 'A', x: 1300, y: 40, width: 800, height: 1000 }],
  layers: [{ id: 'l', name: 'L', kind: 'image', parentId: null, artboardId: 'a', x: 1350, y: 100, width: 100, height: 200, zIndex: 1, visible: true, locked: false }],
}, 'a');
assert.deepEqual(exportedBoard.canvas, { width: 800, height: 1000 });
assert.deepEqual({ x: exportedBoard.layers[0].x, y: exportedBoard.layers[0].y }, { x: 50, y: 60 });
console.log('artboard export normalization tests passed');

const movedBoard = translateArtboard({
  version: '1.0', canvas: { width: 800, height: 1000 },
  artboards: [{ id: 'a', name: 'A', x: 0, y: 0, width: 800, height: 1000 }],
  layers: [{ id: 'l', name: 'L', kind: 'image', parentId: null, artboardId: 'a', x: 50, y: 60, width: 100, height: 200, zIndex: 1, visible: true, locked: false }],
}, 'a', 120, 80);
assert.deepEqual({ x: movedBoard.artboards[0].x, y: movedBoard.artboards[0].y }, { x: 120, y: 80 });
assert.deepEqual({ x: movedBoard.layers[0].x, y: movedBoard.layers[0].y }, { x: 170, y: 140 });
assert.deepEqual(layerToArtboardCoordinates(movedBoard.layers[0], movedBoard.artboards[0]), { x: 50, y: 60 });
console.log('artboard translation tests passed');

const resizedBoard = resizeArtboard(movedBoard, 'a', { x: 150, y: 90, width: 640.4, height: 720.6 });
assert.deepEqual(resizedBoard.artboards[0], { id: 'a', name: 'A', x: 150, y: 90, width: 640, height: 721 });
assert.deepEqual({ x: resizedBoard.layers[0].x, y: resizedBoard.layers[0].y }, { x: 170, y: 140 });
assert.deepEqual(resizedBoard.canvas, { width: 790, height: 811 });
console.log('artboard resize tests passed');

const removedArtboard = removeArtboard({
  ...movedBoard,
  artboards: [
    movedBoard.artboards[0],
    { id: 'b', name: 'B', x: 900, y: 0, width: 300, height: 400 },
  ],
  layers: [
    ...movedBoard.layers,
    { ...movedBoard.layers[0], id: 'b-layer', artboardId: 'b', x: 920, y: 20 },
  ],
}, 'a');
assert.deepEqual(removedArtboard.artboards.map((artboard) => artboard.id), ['b']);
assert.deepEqual(removedArtboard.layers.map((layer) => layer.id), ['b-layer']);
assert.deepEqual(removedArtboard.canvas, { width: 1200, height: 400 });
console.log('artboard deletion tests passed');

const outsideBoard = assignLayerToArtboard(movedBoard, 'l');
assert.equal(outsideBoard.layers[0].artboardId, undefined);
assert.equal(outsideBoard.layers[0].parentId, null);
const reassignedBoard = assignLayerToArtboard(outsideBoard, 'l', 'a');
assert.equal(reassignedBoard.layers[0].artboardId, 'a');
console.log('artboard layer assignment tests passed');

const groupedDocument = createGroupDocument({
  version: '1.0', canvas: { width: 800, height: 1000 },
  artboards: [{ id: 'a', name: 'A', x: 0, y: 0, width: 800, height: 1000 }],
  layers: [
    { id: 'g', name: 'Group1', kind: 'group', parentId: null, artboardId: 'a', x: 100, y: 200, width: 320, height: 180, zIndex: 0, visible: true, locked: false },
    { id: 'c', name: 'Child', kind: 'image', parentId: 'g', artboardId: 'a', x: 80, y: 230, width: 80, height: 60, zIndex: 1, visible: true, locked: false },
  ],
}, 'g');
assert.deepEqual(groupedDocument.canvas, { width: 320, height: 180 });
assert.deepEqual(groupedDocument.artboards[0], { id: 'group-g', name: 'Group1', x: 0, y: 0, width: 320, height: 180 });
assert.deepEqual({ x: groupedDocument.layers[0].x, y: groupedDocument.layers[0].y, parentId: groupedDocument.layers[0].parentId }, { x: -20, y: 30, parentId: null });
console.log('group export normalization tests passed');

assert.equal(artboardContainingPoint({ ...movedBoard, artboards: [
  { id: 'a', name: 'A', x: 0, y: 0, width: 100, height: 100 },
  { id: 'b', name: 'B', x: 140, y: 0, width: 100, height: 100 },
] }, 175, 50)?.id, 'b');
assert.equal(artboardContainingPoint({ ...movedBoard, artboards: [
  { id: 'a', name: 'A', x: 0, y: 0, width: 100, height: 100 },
] }, 120, 50), undefined);
console.log('cross-artboard hit testing passed');

const layerOrderDocument = {
  version: '1.0' as const,
  canvas: { width: 400, height: 400 },
  artboards: [{ id: 'a', name: 'A', x: 0, y: 0, width: 400, height: 400 }],
  layers: [
    { id: 'one', name: 'One', kind: 'image' as const, parentId: null, artboardId: 'a', x: 0, y: 0, width: 10, height: 10, zIndex: 0, visible: true, locked: false },
    { id: 'two', name: 'Two', kind: 'image' as const, parentId: null, artboardId: 'a', x: 0, y: 0, width: 10, height: 10, zIndex: 1, visible: true, locked: false },
    { id: 'three', name: 'Three', kind: 'image' as const, parentId: null, artboardId: 'a', x: 0, y: 0, width: 10, height: 10, zIndex: 2, visible: true, locked: false },
    { id: 'four', name: 'Four', kind: 'image' as const, parentId: null, artboardId: 'a', x: 0, y: 0, width: 10, height: 10, zIndex: 3, visible: true, locked: false },
  ],
};
assert.deepEqual(toggleLayerSelection(['one', 'two'], 'two'), ['one']);
assert.deepEqual(toggleLayerSelection(['one'], 'three'), ['one', 'three']);
assert.deepEqual(rangeLayerSelection(['one', 'two', 'three', 'four'], 'two', 'four'), ['two', 'three', 'four']);
assert.deepEqual(rangeLayerSelection(['one', 'two', 'three', 'four'], 'four', 'two'), ['two', 'three', 'four']);
const batchReordered = reorderLayerBatch(layerOrderDocument, ['one', 'three'], 'four', 'after');
assert.deepEqual([...batchReordered.layers].sort((a, b) => a.zIndex - b.zIndex).map((layer) => layer.id), ['two', 'four', 'one', 'three']);
const batchOutside = assignLayerBatchToArtboard(batchReordered, ['one', 'three']);
assert.equal(batchOutside.layers.find((layer) => layer.id === 'one')?.artboardId, undefined);
assert.equal(batchOutside.layers.find((layer) => layer.id === 'three')?.parentId, null);
assert.deepEqual(rootMovingLayerIds([
  { ...layerOrderDocument.layers[0], id: 'group', kind: 'group' as const },
  { ...layerOrderDocument.layers[1], id: 'child', parentId: 'group' },
], ['group', 'child']), ['group']);
const nestedDocument = {
  ...layerOrderDocument,
  artboards: [...layerOrderDocument.artboards, { id: 'b', name: 'B', x: 500, y: 0, width: 400, height: 400 }],
  layers: [
    { ...layerOrderDocument.layers[0], id: 'group', kind: 'group' as const },
    { ...layerOrderDocument.layers[1], id: 'child', parentId: 'group' },
    { ...layerOrderDocument.layers[2], id: 'target', artboardId: 'b' },
  ],
};
const nestedReordered = reorderLayerBatch(nestedDocument, ['group'], 'target', 'before');
assert.equal(nestedReordered.layers.find((layer) => layer.id === 'child')?.artboardId, 'b');
assert.equal(reorderLayerBatch(nestedDocument, ['group'], 'child', 'before'), nestedDocument);
const nestedOutside = assignLayerBatchToArtboard(nestedDocument, ['group']);
assert.equal(nestedOutside.layers.find((layer) => layer.id === 'child')?.artboardId, undefined);
assert.equal(nestedOutside.layers.find((layer) => layer.id === 'child')?.parentId, 'group');
const nestedDeleted = removeLayerBatch(nestedDocument, ['group', 'child']);
assert.deepEqual(nestedDeleted.layers.map((layer) => layer.id), ['target']);
assert.equal(removeLayerBatch(nestedDocument, []).layers, nestedDocument.layers);
console.log('multi-layer ordering tests passed');

assert.deepEqual(fitLocalAssetToBox({ width: 800, height: 400 }, [100, 200, 300, 400]), { x: 100, y: 250, width: 200, height: 100 });
assert.deepEqual(fitLocalAssetToBox({ width: 400, height: 800 }, [100, 200, 300, 400]), { x: 150, y: 200, width: 100, height: 200 });
assert.deepEqual(fitLocalAssetToBox({ width: 2048, height: 1024 }, [10, 20, 1010, 520]), { x: 10, y: 20, width: 1000, height: 500 });
console.log('local ComfyUI placement tests passed');
