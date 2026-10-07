import Konva from 'konva';
import { fitTextLayer } from '../src/textLayout.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas, Image } from '@napi-rs/canvas';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
import { initializeCanvas, readPsd } from 'ag-psd';
import { createPsd, renderPsdPreview } from '../src/exports.ts';
import { extractSelectionCanvas, rotatedGeometry } from '../src/bitmapGeometry.ts';
import { editorReducer, type EditorState } from '../src/documentHistory.ts';
import { clearWorkspace, loadWorkspace, saveWorkspace, type WorkspaceSnapshot } from '../src/workspacePersistence.ts';
import { localComfyLayerSplit } from '../src/localComfy.ts';
import { runningHubLayerSplit } from '../src/runningHub.ts';
import { selectSplittableBoxes } from '../src/smartSplit.ts';
import type { DocumentState } from '../src/types.ts';
import { applyTextOverlay, hasCurrentText, placeTextLayers, recognizeTextBox, textLayersFromBoxes } from '../src/textRecognition.ts';
import { runVisionOcr } from '../visionOcr.mjs';
import { clientPointToImage } from '../src/coordinates.ts';
import { translateArtboard, layerToArtboardCoordinates } from '../src/artboards.ts';

globalThis.document = { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) } as never;
globalThis.Image = Image as never;
globalThis.indexedDB = indexedDB;
initializeCanvas((w, h) => createCanvas(w, h) as never);

const sourceCanvas = createCanvas(6, 4);
const sourceContext = sourceCanvas.getContext('2d');
sourceContext.fillStyle = '#ff0000'; sourceContext.fillRect(0, 0, 3, 4);
sourceContext.fillStyle = '#00ff00'; sourceContext.fillRect(3, 0, 3, 4);
const source = sourceCanvas.toDataURL('image/png');
const fixture: DocumentState = {
  version: '1.0', canvas: { width: 64, height: 64 },
  artboards: [{ id: 'board', name: 'Board', x: 100, y: 200, width: 64, height: 64 }],
  layers: [
    { id: 'a'.repeat(32), name: 'Group', kind: 'group', parentId: null, artboardId: 'board', x: 110, y: 210, width: 30, height: 30, zIndex: 0, visible: true, locked: false, opacity: 0.5 },
    { id: 'b'.repeat(32), name: 'Image', kind: 'image', parentId: 'a'.repeat(32), artboardId: 'board', x: 130, y: 210, width: 6, height: 4, assetWidth: 6, assetHeight: 4, rotation: 90, zIndex: 1, visible: true, locked: false, opacity: 0.1, source },
    { id: 'c'.repeat(32), name: 'Text', kind: 'text', parentId: null, artboardId: 'board', x: 150, y: 220, width: 10, height: 16, rotation: 90, zIndex: 2, visible: true, locked: false, opacity: 0.5, textContent: 'Hi', textStyle: { fontSize: 8 } },
  ],
};

test('PSD round trip preserves image/text/group opacity, rotation and raster pixels', async () => {
  const psd = readPsd(await createPsd(fixture, 'board'), { skipThumbnail: true });
  const group = psd.children!.find(layer => layer.name === 'Group')!;
  const image = group.children!.find(layer => layer.name === 'Image')!;
  const text = psd.children!.find(layer => layer.name === 'Text')!;
  assert.ok(Math.abs(group.opacity! - 0.5) <= 1 / 255);
  assert.ok(Math.abs(image.opacity! - 0.1) <= 1 / 255);
  assert.ok(Math.abs(text.opacity! - 0.5) <= 1 / 255);
  assert.deepEqual(image.placedLayer!.transform, [30, 10, 30, 16, 26, 16, 26, 10]);
  assert.equal(image.left, 26); assert.equal(image.top, 10);
  assert.equal(image.canvas!.width, 4); assert.equal(image.canvas!.height, 6);
  assert.ok(Math.abs(text.text!.transform![0]) < 1e-8);
  assert.equal(text.text!.transform![1], 1);
  assert.equal(text.text!.transform![2], -1);
  const baseline = -text.text!.top!;
  assert.ok(baseline > 0);
  assert.ok(Math.abs(text.text!.transform![4] - (50 - baseline)) < 1e-5);
  assert.equal(text.text!.transform![5], 20);
  assert.equal(text.text!.shapeType, 'point');
  const previewImage = new Image(); previewImage.src = await renderPsdPreview(fixture, 'board'); await previewImage.decode();
  const preview = createCanvas(64, 64); preview.getContext('2d').drawImage(previewImage, 0, 0);
  assert.deepEqual(psd.canvas!.getContext('2d')!.getImageData(0, 0, 64, 64).data, preview.getContext('2d').getImageData(0, 0, 64, 64).data);
  const rasterized = readPsd(await createPsd(fixture, 'board', undefined, { rasterizeText: true }), { skipThumbnail: true });
  const rasterText = rasterized.children!.find(layer => layer.name === 'Text')!;
  assert.equal(rasterText.text, undefined);
  const fitted = fitTextLayer(fixture.layers[2]);
  assert.equal(rasterText.canvas!.width, fitted.height); assert.equal(rasterText.canvas!.height, fitted.width);
});

test('PSD retains transparent image margins and matches canvas text alignment and baseline', async () => {
  const image = createCanvas(100, 60);
  image.getContext('2d').fillStyle = '#00ff00';
  image.getContext('2d').fillRect(30, 20, 40, 20);
  const textLayer = fitTextLayer({ ...fixture.layers[2], x: 120, y: 240, rotation: 0, textContent: 'AV 5\n开始战斗', textStyle: { fontFamily: 'Arial', fontSize: 20, color: '#ffffff', align: 'center', lineHeight: 1.2, letterSpacing: 2 } });
  const document = { ...fixture, layers: [{ ...fixture.layers[1], parentId: null, rotation: 0, source: image.toDataURL('image/png'), width: 50, height: 30 }, textLayer] };
  const psd = readPsd(await createPsd(document, 'board'), { skipThumbnail: true });
  const exportedImage = psd.children!.find(layer => layer.name === 'Image')!;
  assert.equal(exportedImage.placedLayer!.width, 100); assert.equal(exportedImage.placedLayer!.height, 60);
  assert.equal(exportedImage.canvas!.getContext('2d')!.getImageData(0, 0, 1, 1).data[3], 0);
  assert.deepEqual([...exportedImage.canvas!.getContext('2d')!.getImageData(20, 15, 1, 1).data], [0, 255, 0, 255]);
  const expected = new Konva.Text({ width: textLayer.width, height: textLayer.height, text: textLayer.textContent, fontFamily: 'Arial', fontSize: 20, fill: '#ffffff', align: 'center', lineHeight: 1.2, letterSpacing: 2, wrap: 'none' });
  const expectedCanvas = expected.toCanvas({ x: 0, y: 0, width: textLayer.width, height: textLayer.height, pixelRatio: 1 });
  const exportedText = psd.children!.find(layer => layer.name === 'Text')!;
  assert.deepEqual(exportedText.canvas!.getContext('2d')!.getImageData(0, 0, textLayer.width, textLayer.height).data, expectedCanvas.getContext('2d')!.getImageData(0, 0, textLayer.width, textLayer.height).data);
  assert.ok(Math.abs(exportedText.text!.transform![4] - (20 + textLayer.width / 2)) < 1e-5);
  assert.ok(exportedText.text!.transform![5] > 40);
  assert.equal(exportedText.text!.style!.tracking, 100);
  expected.destroy();
});

test('smart split pointer mapping follows actual image bounds at any zoom and pan', () => {
  // Reproduces a horizontally constrained image whose actual width differs from nominal zoom.
  const rect = { left: 38.65625, top: -1409.53125, width: 1225.333374, height: 2716.395996 };
  const pixel = { x: 550, y: 2100 };
  const mapped = clientPointToImage(rect.left + pixel.x * rect.width / 1170, rect.top + pixel.y * rect.height / 2532, rect, 1170, 2532);
  assert.ok(Math.abs(mapped.x - pixel.x) < 1e-8);
  assert.ok(Math.abs(mapped.y - pixel.y) < 1e-8);
  assert.deepEqual(clientPointToImage(300, 150, { left: 100, top: -50, width: 400, height: 800 }, 800, 1600), { x: 400, y: 400 });
});

test('moving an artboard preserves nested group frames and locked content relative positions', () => {
  const nested = { ...fixture.layers[0], id: 'nested', parentId: fixture.layers[0].id, locked: true, x: 115, y: 215 };
  const other = { ...fixture.layers[0], id: 'outside', artboardId: undefined };
  const document = { ...fixture, layers: [...fixture.layers, nested, other] };
  const moved = translateArtboard(document, 'board', 140, -80);
  document.layers.forEach((original, index) => {
    const layer = moved.layers[index];
    if (original.artboardId !== 'board') { assert.equal(layer, original); return; }
    assert.deepEqual(layerToArtboardCoordinates(layer, moved.artboards[0]), layerToArtboardCoordinates(original, document.artboards[0]));
    assert.equal(layer.parentId, original.parentId);
    assert.equal(layer.width, original.width); assert.equal(layer.height, original.height);
  });
  assert.equal(document.artboards[0], fixture.artboards[0]);
});

test('selection extraction follows moved, scaled and rotated source layers', () => {
  const moved = extractSelectionCanvas(sourceCanvas as never, { x: 500, y: 300, width: 12, height: 8 }, { x: 506, y: 300, width: 6, height: 8 });
  assert.deepEqual([...moved.getContext('2d')!.getImageData(3, 3, 1, 1).data], [0, 255, 0, 255]);
  const rotated = extractSelectionCanvas(sourceCanvas as never, { x: 500, y: 300, width: 6, height: 4, rotation: 90 }, { x: 496, y: 303, width: 4, height: 3 });
  assert.deepEqual([...rotated.getContext('2d')!.getImageData(1, 1, 1, 1).data], [0, 255, 0, 255]);
  assert.deepEqual(rotatedGeometry(0, 0, 6, 4, 90).quad.map(v => Math.round(v)), [0, 0, 0, 6, -4, 6, -4, 0]);
});

test('replaying a reducer action is pure; undo/redo retain immutable images and ignore no-ops', () => {
  const state: EditorState = { scenes: [{ id: 'scene', name: 'Scene', pages: [{ id: 'page', name: 'Page', document: fixture }] }], histories: {} };
  const action = { type: 'document', sceneId: 'scene', pageId: 'page', recordHistory: true, change: (doc: DocumentState) => ({ ...doc, layers: doc.layers.map(layer => layer.kind === 'image' ? { ...layer, x: layer.x + 5 } : layer) }) } as const;
  const first = editorReducer(state, action), replayed = editorReducer(state, action);
  assert.deepEqual(replayed, first);
  assert.deepEqual(state.histories, {});
  assert.equal(first.histories['scene:page'].undo.length, 1);
  assert.equal(first.histories['scene:page'].undo[0], fixture);
  assert.equal(first.scenes[0].pages[0].document.layers[0], fixture.layers[0]);
  const undone = editorReducer(first, { type: 'history', sceneId: 'scene', pageId: 'page', direction: 'undo' });
  assert.equal(undone.scenes[0].pages[0].document, fixture);
  const redone = editorReducer(undone, { type: 'history', sceneId: 'scene', pageId: 'page', direction: 'redo' });
  assert.equal(redone.scenes[0].pages[0].document, first.scenes[0].pages[0].document);
  assert.equal(editorReducer(redone, { ...action, change: doc => ({ ...doc, layers: doc.layers.map(layer => ({ ...layer })) }) }), redone);
  const edited = editorReducer(undone, action);
  assert.equal(edited.histories['scene:page'].redo.length, 0);
});

const snapshot: WorkspaceSnapshot = { version: 1, scenes: [{ id: 'scene', name: 'Scene', pages: [{ id: 'page', name: 'Page', document: fixture }] }], sceneId: 'scene', pageId: 'page', view: { x: 0, y: 0, z: 1 }, collapsedGroups: [], collapsedArtboards: [] };

test('storage separates images, skips document writes for view changes, and rejects aborted commits', async () => {
  await clearWorkspace();
  let assetWrites = 0, documentWrites = 0;
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'assets') assetWrites++;
    if (this.name === 'workspace' && args[1] === 'current') documentWrites++;
    return originalPut.apply(this, args);
  };
  try {
    await saveWorkspace(snapshot);
    await saveWorkspace({ ...snapshot, view: { x: 80, y: 90, z: 0.5 } });
    assert.equal(assetWrites, 1); assert.equal(documentWrites, 1);
    const restored = await loadWorkspace();
    assert.equal(restored!.scenes[0].pages[0].document.layers[1].source, source);
    assert.deepEqual(restored!.view, { x: 80, y: 90, z: 0.5 });
    IDBObjectStore.prototype.put = function (...args) {
      const req = originalPut.apply(this, args);
      if (this.name === 'workspace' && args[1] === 'view') req.addEventListener('success', () => this.transaction.abort());
      return req;
    };
    await assert.rejects(saveWorkspace({ ...snapshot, view: { x: 999, y: 0, z: 1 } }), /事务未提交/);
    IDBObjectStore.prototype.put = originalPut;
    assert.deepEqual((await loadWorkspace())!.view, { x: 80, y: 90, z: 0.5 });
    await saveWorkspace(snapshot); // Failed commits do not poison the serialized save queue.
    await clearWorkspace();
    assert.equal(await loadWorkspace(), undefined);
  } finally { IDBObjectStore.prototype.put = originalPut; }
});

test('version 1 workspace migrates without losing images; unused assets are removed', async () => {
  await clearWorkspace();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('layer-canvas-studio'); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
  });
  const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('layer-canvas-studio', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('workspace');
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = legacyDb.transaction('workspace', 'readwrite');
    tx.objectStore('workspace').put(snapshot, 'current');
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  legacyDb.close();
  const legacy = await loadWorkspace(); assert.equal(legacy!.scenes[0].pages[0].document.layers[1].source, source);
  await saveWorkspace(legacy!);
  const withoutImage = { ...legacy!, scenes: legacy!.scenes.map(scene => ({ ...scene, pages: scene.pages.map(page => ({ ...page, document: { ...page.document, layers: [] } })) })) };
  await saveWorkspace(withoutImage);
  const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open('layer-canvas-studio'); req.onsuccess = () => resolve(req.result); });
  const count = await new Promise<number>(resolve => { const req = db.transaction('assets').objectStore('assets').count(); req.onsuccess = () => resolve(req.result); });
  db.close(); assert.equal(count, 0);
  await clearWorkspace();
});

test('ComfyUI and RunningHub preserve pixels under text without submitting it as an image layer', async () => {
  const boxes = [
    { id: 'text', name: 'Text', type: 'text' as const, shouldSplit: false, bbox: [0, 0, 2, 2] as [number, number, number, number] },
    { id: 'ui', name: 'UI', type: 'ui' as const, bbox: [0, 0, 6, 4] as [number, number, number, number] },
  ];
  const originalFetch = globalThis.fetch;
  try {
    for (const mode of ['local', 'runninghub']) {
      const inputs: string[] = [];
      globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        if (!inputs.length) {
          assert.deepEqual(request.promptOverride, { nodeId: '1', fieldName: 'text', prompt: 'background' });
        } else {
          assert.equal(Object.hasOwn(request, 'promptOverride'), false);
          assert.equal(Object.hasOwn(request, 'prompt'), false);
          if (mode === 'local') assert.equal(request.workflow['1'].inputs.text, 'workflow default');
        }
        if (mode === 'runninghub') {
          assert.equal(Object.hasOwn(request.config, 'backgroundPrompt'), false);
          assert.equal(Object.hasOwn(request.config, 'backgroundPromptNodeId'), false);
          assert.equal(Object.hasOwn(request.config, 'backgroundPromptFieldName'), false);
        }
        inputs.push(request.image);
        return Response.json(mode === 'local' ? { images: [{ base64: source.split(',')[1], mime: 'image/png' }] } : { imageUrl: source });
      };
      const config = { backgroundPromptNodeId: '1', backgroundPrompt: 'background', comfyUrl: 'http://127.0.0.1:8188', workflow: { '1': { inputs: { text: 'workflow default' } } } };
      const result = mode === 'local'
        ? await localComfyLayerSplit(source, selectSplittableBoxes(boxes), config, boxes)
        : await runningHubLayerSplit(source, selectSplittableBoxes(boxes), config, boxes);
      assert.equal(inputs.length, 2); // One background plus one UI crop, no text job.
      assert.equal(config.workflow['1'].inputs.text, 'workflow default');
      assert.equal(result.filter(layer => layer.kind === 'image').length, 2);
      const croppedImage = new Image(); croppedImage.src = inputs[1]; await croppedImage.decode();
      const cropped = createCanvas(6, 4); cropped.getContext('2d').drawImage(croppedImage, 0, 0);
      assert.deepEqual([...cropped.getContext('2d').getImageData(0, 0, 1, 1).data], [255, 0, 0, 255]);
      assert.deepEqual([...cropped.getContext('2d').getImageData(4, 2, 1, 1).data], [0, 255, 0, 255]);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('OCR submits only the selected crop, preserves Unicode and maps text back to source pixels', async () => {
  const originalFetch = globalThis.fetch;
  const box = { id: 'ocr', name: '标题', type: 'text' as const, bbox: [2, 1, 6, 4] as [number, number, number, number] };
  let calls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:8787/api/vision/ocr');
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(request.metadata, { width: 4, height: 3 });
      assert.notEqual(request.image, source);
      return Response.json({ coordinate_space: 'normalized_0_999', regions: [{ text: '金币 123\n确认！', bbox: [0, 0, 999, 999], style: { font_size: 2, color: '#ffd700', bold: true } }] });
    };
    const regions = await recognizeTextBox(source, box);
    assert.equal(calls, 1);
    assert.deepEqual(regions[0].bbox, [2, 1, 6, 4]);
    assert.equal(regions[0].text, '金币 123\n确认！');
    const recognized = { ...box, ocrRegions: regions, ocrBBox: box.bbox };
    assert.equal(hasCurrentText(recognized), true);
    assert.equal(hasCurrentText({ ...recognized, bbox: [1, 1, 6, 4] }), false);
    const textAssets = textLayersFromBoxes([recognized]);
    assert.equal(textAssets[0].kind, 'text'); assert.equal(textAssets[0].source, undefined);
    assert.equal(textAssets[0].textContent, regions[0].text);
    const placed = placeTextLayers(textAssets, { ...fixture.layers[1], x: 500, y: 300, width: 12, height: 8, rotation: 0 }, 6, 4);
    assert.equal(placed[0].x, 504); assert.equal(placed[0].y, 302);
    assert.ok(placed[0].width > 8); assert.ok(placed[0].height > 6);
    assert.equal(placed[0].textStyle!.fontSize, 4); assert.equal(placed[0].textStyle!.color, '#ffd700');
    const rotated = placeTextLayers(textAssets, { ...fixture.layers[1], x: 500, y: 300, width: 12, height: 8, rotation: 90 }, 6, 4);
    assert.equal(rotated[0].x, 498); assert.equal(rotated[0].y, 304);
    globalThis.fetch = async () => { calls++; return Response.json({ error: '识别失败' }, { status: 502 }); };
    await assert.rejects(recognizeTextBox(source, box), /识别失败/);
    assert.equal(calls, 2); // No automatic retry after a potentially billed request.
    globalThis.fetch = async () => { calls++; return Response.json({ error: 'Not found' }, { status: 404 }); };
    await assert.rejects(recognizeTextBox(source, box), /API 服务可能仍为旧版本/);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test('text overlay preserves all existing layers and is undone in one operation', () => {
  const native = { ...fixture.layers[2], id: 'native', textContent: '确认' };
  const converted = applyTextOverlay(fixture, fixture.layers[1].id, [native]);
  assert.equal(converted.layers.length, fixture.layers.length + 1);
  fixture.layers.forEach((layer, index) => assert.equal(converted.layers[index], layer));
  const text = converted.layers.at(-1)!;
  assert.equal(text.textContent, '确认');
  assert.equal(text.x, native.x); assert.equal(text.y, native.y);
  assert.ok(text.zIndex > Math.max(...fixture.layers.map(layer => layer.zIndex)));
  assert.equal(applyTextOverlay(fixture, 'missing', [native]), fixture);
  assert.equal(applyTextOverlay(fixture, fixture.layers[1].id, []), fixture);
  const initial: EditorState = { scenes: [{ id: 's', name: 'Scene', pages: [{ id: 'p', name: 'Page', document: fixture }] }], histories: {} };
  const edited = editorReducer(initial, { type: 'document', sceneId: 's', pageId: 'p', recordHistory: true, change: converted });
  const undone = editorReducer(edited, { type: 'history', sceneId: 's', pageId: 'p', direction: 'undo' });
  assert.equal(undone.scenes[0].pages[0].document, fixture);
});

test('text grows beyond OCR bounds when content or font size increases', () => {
  const native = { ...fixture.layers[2], width: 5, height: 3, textContent: '开始战斗\n确认', textStyle: { fontFamily: 'Arial', fontSize: 60, color: '#ffffff', lineHeight: 1.2 } };
  const fitted = fitTextLayer(native);
  assert.ok(fitted.width > native.width); assert.ok(fitted.height >= 144);
  assert.equal(fitted.x, native.x); assert.equal(fitted.y, native.y);
  const larger = fitTextLayer({ ...fitted, textStyle: { ...native.textStyle, fontSize: 100 } });
  assert.ok(larger.width > fitted.width); assert.ok(larger.height > fitted.height);
  const longer = fitTextLayer({ ...fitted, textContent: '开始战斗开始战斗开始战斗' });
  assert.ok(longer.width > fitted.width);
  assert.equal(fitTextLayer(fitted), fitted);
});

test('OCR backend preserves JSON text/style, handles empty results and never retries failed upstream requests', async () => {
  const config = { image: source, width: 6, height: 4, apiKey: 'test-only', apiUrl: 'https://example.invalid/vision', model: 'test-model' };
  const expected = { coordinate_space: 'normalized_0_999', regions: [{ text: '开始游戏', bbox: [0, 0, 999, 999] }] };
  const result = await runVisionOcr(config, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].content[1].image_url.url, source);
    return Response.json({ choices: [{ message: { content: '```json\n' + JSON.stringify(expected) + '\n```' } }] });
  });
  assert.deepEqual(result, expected);
  let calls = 0;
  await assert.rejects(runVisionOcr(config, async () => { calls++; return Response.json({ error: { message: 'capacity error' } }, { status: 503 }); }), /capacity error/);
  assert.equal(calls, 1);
  assert.deepEqual((await runVisionOcr(config, async () => Response.json({ choices: [{ message: { content: '{"regions":[]}' } }] }))).regions, []);
  await assert.rejects(runVisionOcr({ ...config, width: 0 }), /尺寸无效/);
});
