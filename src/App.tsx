import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Group, Image as KImage, Layer, Rect, Stage, Transformer } from 'react-konva';
import Konva from 'konva';
import { exportJson, exportPsd, exportUnityZip } from './exports';
import { seedreamLayerSplit } from './seedream';
import { importPsd } from './psdImport';
import SmartSplitWorkspace, { type SmartSplitBox } from './SmartSplitWorkspace';
import type { DocumentState, LayerNode, PageState, SceneState } from './types';

const uid = () => crypto.randomUUID().replaceAll('-', '');
const empty = (): DocumentState => ({ version: '1.0', canvas: { width: 1920, height: 1080 }, layers: [] });
const newPage = (name: string): PageState => ({ id: uid(), name, document: empty() });
function useBitmap(source?: string) { const [image, setImage] = useState<HTMLImageElement>(); useEffect(() => { if (!source) { setImage(undefined); return; } const next = new Image(); next.onload = () => setImage(next); next.src = source; }, [source]); return image; }
function VisibilityIcon({ visible }: { visible: boolean }) {
  return <svg className="visibility-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5 9.5-5 9.5 5 9.5 5-3.4 5-9.5 5-9.5-5-9.5-5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />{visible ? <circle cx="12" cy="12" r="2.6" fill="currentColor" /> : <path d="m4 4 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}</svg>;
}
const labelTextWidth = (group: Konva.Group) => { const texts = group.find('Text'); return texts.length ? (texts[texts.length - 1] as Konva.Text).width() : group.getClientRect({ skipTransform: true }).width; };

function Sprite({ layer, selected, keepRatio, select, patch, sync }: { layer: LayerNode; selected: boolean; keepRatio: boolean; select: () => void; patch: (v: Partial<LayerNode>) => void; sync: (id: string, node: Konva.Image) => void }) {
  const image = useBitmap(layer.source); const ref = useRef<Konva.Image>(null), tr = useRef<Konva.Transformer>(null);
  useEffect(() => { if (selected && ref.current && tr.current) { tr.current.nodes([ref.current]); tr.current.getLayer()?.batchDraw(); } }, [selected, image, keepRatio]);
  if (!layer.visible) return null;
  if (layer.kind === 'selection') return <Rect x={layer.x} y={layer.y} width={layer.width} height={layer.height} stroke="#b6f04a" dash={[8, 5]} fill="rgba(182,240,74,.08)" draggable={!layer.locked} onClick={select} onDragStart={e => { e.cancelBubble = true; select(); }} onDragEnd={e => { e.cancelBubble = true; patch({ x: Math.round(e.target.x()), y: Math.round(e.target.y()) }); }} />;
  if (layer.kind === 'group') return null;
  return <><KImage id={layer.id} ref={ref} image={image} x={layer.x} y={layer.y} width={layer.width} height={layer.height} rotation={layer.rotation || 0} opacity={layer.opacity ?? 1} draggable={!layer.locked} onClick={select} onDragStart={e => { e.cancelBubble = true; select(); }} onDragMove={() => { if (ref.current) { sync(layer.id, ref.current); tr.current?.forceUpdate(); } }} onDragEnd={e => { e.cancelBubble = true; patch({ x: Math.round(e.target.x()), y: Math.round(e.target.y()) }); }} onTransformEnd={() => { const node = ref.current!; patch({ x: Math.round(node.x()), y: Math.round(node.y()), width: Math.max(2, Math.round(layer.width * node.scaleX())), height: Math.max(2, Math.round(layer.height * node.scaleY())), rotation: Math.round(node.rotation()) }); node.scale({ x: 1, y: 1 }); }} />{selected && !layer.locked && <Transformer ref={tr} rotateEnabled keepRatio={keepRatio} flipEnabled={false} borderStroke="#b6f04a" borderStrokeWidth={2} anchorSize={10} anchorStroke="#d9ff86" anchorStrokeWidth={1} anchorFill="#b6f04a" anchorCornerRadius={1} />}</>;
}

type Bounds = { x: number; y: number; width: number; height: number };

export default function App() {
  const file = useRef<HTMLInputElement>(null), host = useRef<HTMLDivElement>(null), draggingLayerId = useRef<string | null>(null), history = useRef(new Map<string, { undo: DocumentState[]; redo: DocumentState[] }>()), liveLabels = useRef(new Map<string, Konva.Group>()), layerViewMode = useRef<'layers' | 'resources'>('layers');
  const initial = { id: uid(), name: '场景 1', pages: [newPage('Page 1')] };
  const [scenes, setScenes] = useState<SceneState[]>([initial]), [sceneId, setSceneId] = useState(initial.id), [pageId, setPageId] = useState(initial.pages[0].id), [selectedId, setSelectedId] = useState<string | null>(null), [view, setView] = useState({ x: 80, y: 80, z: .5 }), [size, setSize] = useState({ width: 900, height: 700 }), [tab, setTab] = useState<'design' | 'note' | 'ai'>('design'), [ratioLocked, setRatioLocked] = useState(true), [notice, setNotice] = useState('在场景中创建 Page；每个 Page 都拥有独立画布与图层。'), [menu, setMenu] = useState<{ x: number; y: number; s: string; p: string } | null>(null), [splitting, setSplitting] = useState(false), [smartSplitOpen, setSmartSplitOpen] = useState(false);
  const [contentSelectionIds, setContentSelectionIds] = useState<string[]>([]), [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const scene = scenes.find(s => s.id === sceneId)!, page = scene.pages.find(p => p.id === pageId)!, doc = page.document, selected = doc.layers.find(l => l.id === selectedId), ordered = useMemo(() => [...doc.layers].sort((a, b) => a.zIndex - b.zIndex), [doc.layers]);
  const descendants = (parentId: string): LayerNode[] => doc.layers.filter(layer => layer.parentId === parentId).flatMap(layer => [layer, ...(layer.kind === 'group' ? descendants(layer.id) : [])]);
  const descendantImages = (parentId: string) => descendants(parentId).filter(layer => layer.kind === 'image').map(layer => layer.id);
  const effectivelyVisible = (layer: LayerNode) => { let current: LayerNode | undefined = layer; while (current) { if (!current.visible) return false; current = current.parentId ? doc.layers.find(item => item.id === current!.parentId) : undefined; } return true; };
  const selectLayer = (layer: LayerNode) => { setSelectedId(layer.id); setContentSelectionIds(layer.kind === 'group' ? descendantImages(layer.id) : []); };
  const syncLiveLayer = (id: string, node: Konva.Image) => { const label = liveLabels.current.get(id); if (!label) return; label.position({ x: node.x() + node.width() / 2 - labelTextWidth(label) / 2, y: node.y() + node.height() + 14 / view.z }); label.getLayer()?.batchDraw(); };
  useEffect(() => {
    if (!smartSplitOpen || !selected || selected.kind !== 'image') return;
    const mount = document.createElement('div'); mount.className = 'smart-split-mount'; document.body.appendChild(mount);
    const root = createRoot(mount);
    root.render(<SmartSplitWorkspace image={selected} onCancel={() => setSmartSplitOpen(false)} onStart={async boxes => { await splitWithSeedream(selected, boxes, true); setSmartSplitOpen(false); }} />);
    return () => { root.unmount(); mount.remove(); };
  }, [smartSplitOpen, selectedId]);
  useEffect(() => { const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); if (host.current) observer.observe(host.current); return () => observer.disconnect(); }, []);
  useEffect(() => {
    if (!file.current) return;
    file.current.accept = 'image/*,.psd,application/octet-stream';
    file.current.multiple = true;
    const chooseFiles = (event: Event) => {
      const input = event.currentTarget as HTMLInputElement;
      event.stopImmediatePropagation();
      Array.from(input.files || []).forEach(upload);
      input.value = '';
    };
    file.current.addEventListener('change', chooseFiles, true);
    return () => file.current?.removeEventListener('change', chooseFiles, true);
  }, [doc.layers]);
  const setDoc = (change: DocumentState | ((d: DocumentState) => DocumentState), recordHistory = true) => setScenes(old => old.map(s => s.id !== scene.id ? s : { ...s, pages: s.pages.map(p => {
    if (p.id !== page.id) return p;
    const next = typeof change === 'function' ? change(p.document) : change;
    if (recordHistory && JSON.stringify(next) !== JSON.stringify(p.document)) {
      const key = `${s.id}:${p.id}`, stack = history.current.get(key) || { undo: [], redo: [] };
      stack.undo.push(structuredClone(p.document)); if (stack.undo.length > 100) stack.undo.shift(); stack.redo = []; history.current.set(key, stack);
    }
    return { ...p, document: next };
  }) }));
  const patch = (layerId: string, value: Partial<LayerNode>) => setDoc(d => {
    const target = d.layers.find(layer => layer.id === layerId);
    const isPureMove = Object.keys(value).every(key => key === 'x' || key === 'y');
    // A marquee selection behaves like Photoshop's multi-object selection: dragging any
    // selected image applies the same delta to every selected image.
    if (target?.boxSelected && isPureMove && typeof value.x === 'number' && typeof value.y === 'number') {
      const dx = Math.round(value.x - target.x), dy = Math.round(value.y - target.y);
      return { ...d, layers: d.layers.map(layer => !layer.boxSelected ? layer : layer.id === layerId ? { ...layer, ...value } : { ...layer, x: layer.x + dx, y: layer.y + dy }) };
    }
    return { ...d, layers: d.layers.map(layer => layer.id === layerId ? { ...layer, ...value } : layer) };
  });
  const restoreHistory = (direction: 'undo' | 'redo') => {
    const key = `${scene.id}:${page.id}`, stack = history.current.get(key);
    if (!stack?.[direction].length) return setNotice(direction === 'undo' ? '没有可撤销的操作。' : '没有可重做的操作。');
    const snapshot = stack[direction].pop()!;
    const opposite = direction === 'undo' ? 'redo' : 'undo';
    stack[opposite].push(structuredClone(doc)); history.current.set(key, stack);
    setDoc(snapshot, false); setContentSelectionIds([]); setSelectedId(null); setNotice(direction === 'undo' ? '已撤销。' : '已重做。');
  };
  const reorderLayers = (draggedId: string, targetId: string) => setDoc(d => {
    if (draggedId === targetId) return d;
    const stack = [...d.layers].sort((a, b) => b.zIndex - a.zIndex);
    const dragged = stack.find(layer => layer.id === draggedId);
    if (!dragged) return d;
    const withoutDragged = stack.filter(layer => layer.id !== draggedId);
    const targetIndex = withoutDragged.findIndex(layer => layer.id === targetId);
    if (targetIndex < 0) return d;
    withoutDragged.splice(targetIndex, 0, dragged);
    const zById = new Map(withoutDragged.map((layer, index) => [layer.id, withoutDragged.length - index - 1]));
    return { ...d, layers: withoutDragged.map(layer => ({ ...layer, zIndex: zById.get(layer.id) ?? layer.zIndex })) };
  });
  const choose = (s: string, p: string) => { setSceneId(s); setPageId(p); setSelectedId(null); setView({ x: 80, y: 80, z: .5 }); };
  const addPage = (s: string) => { const target = scenes.find(x => x.id === s)!; const p = newPage(`Page ${target.pages.length + 1}`); setScenes(old => old.map(x => x.id === s ? { ...x, pages: [...x.pages, p] } : x)); choose(s, p.id); };
  const rename = (s: string, p: string) => { const old = scenes.find(x => x.id === s)?.pages.find(x => x.id === p); const name = window.prompt('Page 名称', old?.name); if (name?.trim()) setScenes(all => all.map(x => x.id !== s ? x : { ...x, pages: x.pages.map(y => y.id === p ? { ...y, name: name.trim() } : y) })); };
  const copy = (s: string, p: string) => { const source = scenes.find(x => x.id === s)?.pages.find(x => x.id === p); if (!source) return; const next = { id: uid(), name: `${source.name} 副本`, document: structuredClone(source.document) }; setScenes(all => all.map(x => x.id === s ? { ...x, pages: [...x.pages, next] } : x)); choose(s, next.id); };
  const drop = (s: string, p: string) => { const parent = scenes.find(x => x.id === s)!; if (parent.pages.length < 2) return setNotice('每个场景至少保留一个 Page。'); const pages = parent.pages.filter(x => x.id !== p); setScenes(all => all.map(x => x.id !== s ? x : { ...x, pages })); if (pageId === p) choose(s, pages[0].id); };
  const importPsdFile = async (input: File) => { try { setNotice('正在本地读取 PSD 图层…'); const imported = await importPsd(input); const hasExistingLayers = doc.layers.length > 0; const imageLayer = imported.layers.find(layer => layer.kind === 'image'); setDoc(current => {
    const offsetX = current.layers.length ? current.canvas.width + 120 : 0;
    const baseZ = Math.max(-1, ...current.layers.map(layer => layer.zIndex)) + 1;
    const appended = imported.layers.map((layer, index) => ({ ...layer, x: layer.x + offsetX, zIndex: baseZ + index, boxSelected: false }));
    return { ...current, canvas: { width: Math.max(current.canvas.width, offsetX + imported.canvas.width), height: Math.max(current.canvas.height, imported.canvas.height) }, layers: [...current.layers, ...appended] };
  }); setContentSelectionIds([]); setSelectedId(imageLayer?.id || null); if (!hasExistingLayers) { const z = Math.min((size.width - 140) / imported.canvas.width, (size.height - 140) / imported.canvas.height, 1); setView({ z, x: (size.width - imported.canvas.width * z) / 2, y: (size.height - imported.canvas.height * z) / 2 }); } setNotice(`已追加 PSD：${imported.layers.filter(layer => layer.kind === 'image').length} 个图像图层，已有图层保持不变。`); } catch (error) { setNotice(error instanceof Error ? `PSD 导入失败：${error.message}` : 'PSD 导入失败。'); } };
  const upload = (input?: File) => { if (!input) return; if (input.name.toLowerCase().endsWith('.psd')) { void importPsdFile(input); return; } if (!input.type.startsWith('image/')) return; const reader = new FileReader(); reader.onload = () => { const source = String(reader.result), image = new Image(); image.onload = () => { const id = uid(); setDoc(d => { const imageCount = d.layers.filter(layer => layer.kind === 'image').length, first = imageCount === 0; const x = first ? 0 : 80 + (imageCount - 1) * 36, y = first ? 0 : 80 + (imageCount - 1) * 36; const layer: LayerNode = { id, name: input.name.replace(/\.[^.]+$/, ''), kind: 'image', parentId: null, x, y, width: image.naturalWidth, height: image.naturalHeight, assetWidth: image.naturalWidth, assetHeight: image.naturalHeight, zIndex: Math.max(-1, ...d.layers.map(layer => layer.zIndex)) + 1, visible: true, locked: false, opacity: 1, source }; return { ...d, canvas: { width: Math.max(d.canvas.width, x + image.naturalWidth), height: Math.max(d.canvas.height, y + image.naturalHeight) }, layers: [...d.layers, layer] }; }); setSelectedId(id); if (!doc.layers.some(layer => layer.kind === 'image')) { const z = Math.min((size.width - 140) / image.naturalWidth, (size.height - 140) / image.naturalHeight, 1); setView({ z, x: (size.width - image.naturalWidth * z) / 2, y: (size.height - image.naturalHeight * z) / 2 }); } }; image.src = source; }; reader.readAsDataURL(input); };
  const addSelection = () => { const width = Math.min(260, doc.canvas.width * .2), height = Math.min(160, doc.canvas.height * .15); const layer: LayerNode = { id: uid(), name: '待提取区域', kind: 'selection', parentId: null, x: Math.round((doc.canvas.width - width) / 2), y: Math.round((doc.canvas.height - height) / 2), width: Math.round(width), height: Math.round(height), zIndex: Math.max(0, ...doc.layers.map(l => l.zIndex)) + 1, visible: true, locked: false }; setDoc(d => ({ ...d, layers: [...d.layers, layer] })); setSelectedId(layer.id); };
  const extract = () => { if (selected?.kind !== 'selection') return setNotice('请选择待提取区域。'); const source = doc.layers.find(l => l.kind === 'image')?.source; if (!source) return; const image = new Image(); image.onload = () => { const canvas = window.document.createElement('canvas'); canvas.width = selected.width; canvas.height = selected.height; canvas.getContext('2d')!.drawImage(image, selected.x, selected.y, selected.width, selected.height, 0, 0, selected.width, selected.height); const layer: LayerNode = { ...selected, id: uid(), name: `图层_${doc.layers.length}`, kind: 'image', locked: false, opacity: 1, assetWidth: canvas.width, assetHeight: canvas.height, source: canvas.toDataURL('image/png') }; setDoc(d => ({ ...d, layers: d.layers.map(l => l.id === selected.id ? layer : l) })); setSelectedId(layer.id); }; image.src = source; };
  const groupSelectedLayers = () => {
    const ids = contentSelectionIds.filter(id => doc.layers.some(layer => layer.id === id && layer.kind === 'image'));
    if (!ids.length) return setNotice('请先在画布中框选至少一个图片图层。');
    const groupId = uid();
    setDoc(current => {
      const children = current.layers.filter(layer => ids.includes(layer.id));
      const group: LayerNode = { id: groupId, name: `Group${current.layers.filter(layer => layer.kind === 'group').length + 1}`, kind: 'group', parentId: null, x: 0, y: 0, width: Math.max(1, ...children.map(layer => layer.width)), height: Math.max(1, ...children.map(layer => layer.height)), zIndex: Math.min(...children.map(layer => layer.zIndex)), visible: true, locked: false };
      return { ...current, layers: [...current.layers.map(layer => ids.includes(layer.id) ? { ...layer, parentId: groupId, boxSelected: false } : layer), group] };
    });
    setContentSelectionIds(ids); setSelectedId(groupId); setNotice(`已创建图层组，包含 ${ids.length} 个图片图层。`);
  };
  const moveMultiSelection = (dx: number, dy: number) => {
    if (!dx && !dy) return;
    setDoc(current => ({ ...current, layers: current.layers.map(layer => contentSelectionIds.includes(layer.id) ? { ...layer, x: layer.x + dx, y: layer.y + dy } : layer) }));
  };
  const scaleMultiSelection = (bounds: Bounds, originX: number, originY: number, sx: number, sy: number) => {
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return;
    setDoc(current => ({ ...current, layers: current.layers.map(layer => !contentSelectionIds.includes(layer.id) ? layer : {
      ...layer,
      x: Math.round(originX + (layer.x - bounds.x) * sx), y: Math.round(originY + (layer.y - bounds.y) * sy),
      width: Math.max(2, Math.round(layer.width * sx)), height: Math.max(2, Math.round(layer.height * sy)),
    }) }));
  };
  const wheel = (event: Konva.KonvaEventObject<WheelEvent>) => { event.evt.preventDefault(); const point = event.target.getStage()!.getPointerPosition()!, z = Math.max(.08, Math.min(4, view.z * (event.evt.deltaY > 0 ? .9 : 1.1))), world = { x: (point.x - view.x) / view.z, y: (point.y - view.y) / view.z }; setView({ z, x: point.x - world.x * z, y: point.y - world.y * z }); };
  const field = (label: string, key: keyof LayerNode, value: number) => <label>{label}<input type="number" value={value} onChange={e => selected && patch(selected.id, { [key]: +e.target.value })} /></label>;
  const resize = (axis: 'width' | 'height', value: number) => { if (!selected) return; const next = Math.max(2, value); if (!ratioLocked) return patch(selected.id, { [axis]: next }); const ratio = selected.width / selected.height; patch(selected.id, axis === 'width' ? { width: next, height: Math.max(2, Math.round(next / ratio)) } : { height: next, width: Math.max(2, Math.round(next * ratio)) }); };
  const targetIds = () => contentSelectionIds.length > 1 ? contentSelectionIds : selected ? [selected.id] : [];
  const alignLayers = (mode: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom' | 'spaceX' | 'spaceY') => {
    const ids = targetIds(); if (!ids.length) return;
    setDoc(current => {
      const targets = current.layers.filter(layer => ids.includes(layer.id) && layer.kind === 'image');
      if (!targets.length) return current;
      if ((mode === 'spaceX' || mode === 'spaceY') && targets.length < 3) { setNotice('等距分布至少需要选择 3 个图片图层。'); return current; }
      const next = new Map<string, Partial<LayerNode>>();
      if (mode === 'spaceX') { const sorted = [...targets].sort((a, b) => a.x - b.x), left = sorted[0].x, right = sorted.at(-1)!.x + sorted.at(-1)!.width, total = sorted.reduce((sum, layer) => sum + layer.width, 0), gap = (right - left - total) / (sorted.length - 1); let x = left; sorted.forEach(layer => { next.set(layer.id, { x: Math.round(x) }); x += layer.width + gap; }); }
      else if (mode === 'spaceY') { const sorted = [...targets].sort((a, b) => a.y - b.y), top = sorted[0].y, bottom = sorted.at(-1)!.y + sorted.at(-1)!.height, total = sorted.reduce((sum, layer) => sum + layer.height, 0), gap = (bottom - top - total) / (sorted.length - 1); let y = top; sorted.forEach(layer => { next.set(layer.id, { y: Math.round(y) }); y += layer.height + gap; }); }
      else targets.forEach(layer => next.set(layer.id, mode === 'left' ? { x: 0 } : mode === 'centerX' ? { x: Math.round((current.canvas.width - layer.width) / 2) } : mode === 'right' ? { x: current.canvas.width - layer.width } : mode === 'top' ? { y: 0 } : mode === 'centerY' ? { y: Math.round((current.canvas.height - layer.height) / 2) } : { y: current.canvas.height - layer.height }));
      return { ...current, layers: current.layers.map(layer => next.has(layer.id) ? { ...layer, ...next.get(layer.id) } : layer) };
    });
  };
  const transformSelectedBitmap = (mode: 'flipX' | 'flipY' | 'rotate90') => {
    if (!selected?.source || selected.kind !== 'image') return;
    const image = new Image(); image.onload = () => {
      const canvas = document.createElement('canvas'), rotate = mode === 'rotate90'; canvas.width = rotate ? image.naturalHeight : image.naturalWidth; canvas.height = rotate ? image.naturalWidth : image.naturalHeight;
      const context = canvas.getContext('2d')!; context.save();
      if (mode === 'flipX') { context.translate(canvas.width, 0); context.scale(-1, 1); }
      else if (mode === 'flipY') { context.translate(0, canvas.height); context.scale(1, -1); }
      else { context.translate(canvas.width, 0); context.rotate(Math.PI / 2); }
      context.drawImage(image, 0, 0); context.restore();
      if (rotate) patch(selected.id, { source: canvas.toDataURL('image/png'), x: Math.round(selected.x + (selected.width - selected.height) / 2), y: Math.round(selected.y + (selected.height - selected.width) / 2), width: selected.height, height: selected.width, assetWidth: canvas.width, assetHeight: canvas.height });
      else patch(selected.id, { source: canvas.toDataURL('image/png'), assetWidth: canvas.width, assetHeight: canvas.height });
    }; image.src = selected.source;
  };
  const splitWithSeedream = async (targetLayer = doc.layers.find(layer => layer.kind === 'image'), boxes?: SmartSplitBox[], propagateError = false) => {
    const source = targetLayer?.source;
    if (!source) return setNotice('请先导入一张图片，再使用 AI 拆分。');
    if (splitting) return;
    setSplitting(true); setNotice('Seedream 5.0 Pro 正在拆分图层…');
    try {
      const prompt = boxes?.length ? `按用户提供的区域元数据拆分游戏 UI 图层。只处理这些区域，保持每个区域的名称、类型和原图像素位置：${JSON.stringify(boxes.map(({ id, thumbnail, ...box }) => box))}` : undefined;
      const layers = await seedreamLayerSplit(source, targetLayer?.assetWidth || targetLayer?.width || doc.canvas.width, targetLayer?.assetHeight || targetLayer?.height || doc.canvas.height, prompt, boxes);
      const sourceLayer = targetLayer;
      const gap = 120;
      const originX = (sourceLayer?.x ?? 0) + (sourceLayer?.width ?? doc.canvas.width) + gap;
      const baseZ = Math.max(-1, ...doc.layers.map(layer => layer.zIndex)) + 1;
      const placed = layers.map((layer, index) => ({ ...layer, name: `AI · ${layer.name}`, x: originX + layer.x, zIndex: baseZ + index }));
      const splitRight = Math.max(...placed.map(layer => layer.x + layer.width));
      const splitBottom = Math.max(...placed.map(layer => layer.y + layer.height));
      setDoc(d => ({ ...d, canvas: { width: Math.max(d.canvas.width, Math.ceil(splitRight)), height: Math.max(d.canvas.height, Math.ceil(splitBottom)) }, layers: [...d.layers, ...placed] }));
      setSelectedId(placed[0].id); setNotice(`已在原图右侧新增 ${placed.length} 个 Seedream 图层。`);
    }
    catch (error) { if (propagateError) throw error; setNotice(error instanceof Error ? error.message : 'Seedream 图层拆分失败。'); }
    finally { setSplitting(false); }
  };
  useEffect(() => {
    if (tab !== 'ai') return;
    const button = document.querySelector<HTMLButtonElement>('.ai-panel button');
    if (!button) return;
    const handler = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); void splitWithSeedream(); };
    button.addEventListener('click', handler, true);
    return () => button.removeEventListener('click', handler, true);
  }, [tab, doc, splitting]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'g') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      groupSelectedLayers();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [contentSelectionIds, doc.layers]);
  useEffect(() => {
    const onHistoryKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      restoreHistory(event.altKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onHistoryKey);
    return () => window.removeEventListener('keydown', onHistoryKey);
  }, [scene.id, page.id, doc]);
  useEffect(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.tree .layer-row'));
    const cleanups = rows.map((row, index) => {
      const layerId = row.dataset.layerId;
      if (!layerId) return () => undefined;
      row.draggable = true;
      row.title = '拖动到另一图层上方以调整层级';
      const start = (event: DragEvent) => { draggingLayerId.current = layerId; event.dataTransfer?.setData('text/plain', layerId); event.dataTransfer!.effectAllowed = 'move'; };
      const over = (event: DragEvent) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; };
      const dropOn = (event: DragEvent) => { event.preventDefault(); const draggedId = draggingLayerId.current || event.dataTransfer?.getData('text/plain'); if (draggedId) reorderLayers(draggedId, layerId); draggingLayerId.current = null; };
      const end = () => { draggingLayerId.current = null; };
      row.addEventListener('dragstart', start); row.addEventListener('dragover', over); row.addEventListener('drop', dropOn); row.addEventListener('dragend', end);
      return () => { row.removeEventListener('dragstart', start); row.removeEventListener('dragover', over); row.removeEventListener('drop', dropOn); row.removeEventListener('dragend', end); };
    });
    return () => cleanups.forEach(cleanup => cleanup());
  }, [doc.layers]);
  useEffect(() => {
    const stage = Konva.stages.find(candidate => Boolean(host.current && host.current.contains(candidate.container())));
    if (!stage) return;
    const container = stage.container();
    // Capture the middle button before any image, Transformer anchor, or canvas toolbar
    // node can handle it. Middle-button interaction is exclusively canvas panning.
    const beginMiddlePan = (event: MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      stage.setPointersPositions(event);
      stage.draggable(true);
      stage.startDrag(event);
    };
    const endMiddlePan = (event: MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      stage.stopDrag();
      stage.draggable(false);
    };
    container.addEventListener('mousedown', beginMiddlePan, true);
    container.addEventListener('mouseup', endMiddlePan, true);
    container.addEventListener('auxclick', endMiddlePan, true);
    window.addEventListener('mouseup', endMiddlePan, true);
    // Do not leave the Stage draggable: otherwise it competes with child image drags and causes cursor-relative jumps.
    stage.draggable(false);
    const beginPan = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if ('button' in event.evt && event.evt.button !== 1) return;
      event.evt.preventDefault();
      stage.draggable(true);
      stage.startDrag(event.evt);
    };
    const endPan = () => stage.draggable(false);
    const protectChildDrag = (event: Konva.KonvaEventObject<DragEvent>) => {
      if (event.target === stage) return;
      stage.stopDrag();
      stage.draggable(false);
    };
    stage.on('mousedown.canvas-pan touchstart.canvas-pan', beginPan);
    stage.on('dragstart.canvas-pan', protectChildDrag);
    stage.on('dragend.canvas-pan', endPan);
    return () => {
      container.removeEventListener('mousedown', beginMiddlePan, true);
      container.removeEventListener('mouseup', endMiddlePan, true);
      container.removeEventListener('auxclick', endMiddlePan, true);
      window.removeEventListener('mouseup', endMiddlePan, true);
      stage.off('.canvas-pan'); stage.draggable(false);
    };
  }, [doc.layers, size.width, size.height]);
  useEffect(() => {
    const stage = Konva.stages.find(candidate => Boolean(host.current && host.current.contains(candidate.container())));
    if (!stage) return;
    // react-konva's parent onDragEnd also receives child drag events. Replace it with a target-aware handler.
    stage.off('dragend');
    const finish = (event: Konva.KonvaEventObject<DragEvent>) => {
      if (event.target === stage) setView(current => ({ ...current, x: Math.round(stage.x()), y: Math.round(stage.y()) }));
      stage.draggable(false);
    };
    stage.on('dragend.drag-fix', finish);
    return () => { stage.off('.drag-fix'); };
  }, [doc.layers, selectedId, size.width, size.height, view.x, view.y, view.z]);
  useEffect(() => {
    const stage = Konva.stages.find(candidate => Boolean(host.current && host.current.contains(candidate.container())));
    if (!stage) return;
    const openDesign = (event: Konva.KonvaEventObject<MouseEvent>) => { if (event.target instanceof Konva.Image) setTab('design'); };
    stage.on('click.inspector-open tap.inspector-open', openDesign);
    return () => { stage.off('.inspector-open'); };
  }, [doc.layers, size.width, size.height]);
  useEffect(() => {
    const stage = Konva.stages.find(candidate => Boolean(host.current && host.current.contains(candidate.container())));
    if (!stage || !selected || selected.kind !== 'image') return;
    stage.find('Transformer').forEach(node => (node as Konva.Transformer).rotateEnabled(false));
    const visibleImages = [...doc.layers].sort((a, b) => a.zIndex - b.zIndex).filter(layer => layer.kind === 'image' && layer.visible);
    const image = stage.find('Image')[visibleImages.findIndex(layer => layer.id === selected.id)] as Konva.Image | undefined;
    if (!image) return;
    let start: { angle: number; rotation: number } | undefined;
    const point = () => { const pointer = stage.getPointerPosition()!; return { x: (pointer.x - stage.x()) / stage.scaleX(), y: (pointer.y - stage.y()) / stage.scaleY() }; };
    const cornerAngle = () => {
      const p = point(), corners = [[selected.x, selected.y], [selected.x + selected.width, selected.y], [selected.x, selected.y + selected.height], [selected.x + selected.width, selected.y + selected.height]];
      const corner = corners.find(([x, y]) => Math.hypot(p.x - x, p.y - y) <= 26 && (p.x < x - 5 || p.x > x + 5 || p.y < y - 5 || p.y > y + 5));
      if (!corner) return undefined;
      return Math.atan2(p.y - (selected.y + selected.height / 2), p.x - (selected.x + selected.width / 2));
    };
    const move = () => { const angle = cornerAngle(); stage.container().style.cursor = angle === undefined && !start ? 'default' : 'crosshair'; if (!start) return; const p = point(), current = Math.atan2(p.y - (selected.y + selected.height / 2), p.x - (selected.x + selected.width / 2)); image.rotation(start.rotation + (current - start.angle) * 180 / Math.PI); image.getLayer()?.batchDraw(); };
    const down = (event: Konva.KonvaEventObject<MouseEvent>) => { if (event.evt.button !== 0) return; const angle = cornerAngle(); if (angle === undefined) return; event.cancelBubble = true; start = { angle, rotation: image.rotation() }; stage.container().style.cursor = 'crosshair'; };
    const up = () => { if (start) patch(selected.id, { rotation: Math.round(image.rotation()) }); start = undefined; stage.container().style.cursor = 'default'; };
    stage.on('mousemove.corner-rotate', move); stage.on('mousedown.corner-rotate', down); stage.on('mouseup.corner-rotate', up);
    return () => { stage.off('.corner-rotate'); stage.container().style.cursor = 'default'; };
  }, [selectedId, doc.layers, size.width, size.height, view.x, view.y, view.z]);
  useEffect(() => {
    const stage = Konva.stages.find(candidate => Boolean(host.current && host.current.contains(candidate.container())));
    const layer = stage?.getLayers()[0];
    if (!stage || !layer) return;
    let start: { x: number; y: number } | undefined;
    let marquee: Konva.Rect | undefined;
    const point = () => { const pointer = stage.getPointerPosition()!; return { x: (pointer.x - stage.x()) / stage.scaleX(), y: (pointer.y - stage.y()) / stage.scaleY() }; };
    const begin = (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (event.evt.button !== 0 || event.target !== stage) return;
      event.evt.preventDefault(); stage.stopDrag(); stage.draggable(false); start = point();
      marquee = new Konva.Rect({ x: start.x, y: start.y, width: 0, height: 0, stroke: '#b6f04a', strokeWidth: 2, dash: [7, 5], fill: 'rgba(182,240,74,.12)', listening: false });
      layer.add(marquee); layer.batchDraw();
    };
    const move = () => { if (!start || !marquee) return; const end = point(); marquee.setAttrs({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }); layer.batchDraw(); };
    const finish = () => {
      if (!start || !marquee) return;
      const x = Math.round(marquee.x()), y = Math.round(marquee.y()), width = Math.round(marquee.width()), height = Math.round(marquee.height());
      marquee.destroy(); layer.batchDraw(); marquee = undefined; start = undefined;
      if (width < 3 || height < 3) { setContentSelectionIds([]); setSelectedId(null); setDoc(current => ({ ...current, layers: current.layers.map(item => item.boxSelected ? { ...item, boxSelected: false } : item) }), false); return; }
      const selectedIds = doc.layers.filter(item => item.kind === 'image' && item.visible && item.x < x + width && item.x + item.width > x && item.y < y + height && item.y + item.height > y).map(item => item.id);
      setDoc(current => ({ ...current, layers: current.layers.map(item => ({ ...item, boxSelected: selectedIds.includes(item.id) })) }), false);
      setContentSelectionIds(selectedIds); setSelectedId(selectedIds.length === 1 ? selectedIds[0] : null);
      setNotice(selectedIds.length ? `已框选 ${selectedIds.length} 个图层。` : '框选范围内没有图层。');
    };
    stage.on('mousedown.marquee', begin); stage.on('mousemove.marquee', move); stage.on('mouseup.marquee', finish);
    return () => { stage.off('.marquee'); marquee?.destroy(); };
  }, [doc.layers, sceneId, pageId, size.width, size.height, view.x, view.y, view.z]);
  useEffect(() => {
    const stage = Konva.stages.find(candidate => Boolean(host.current && host.current.contains(candidate.container())));
    const canvasLayer = stage?.getLayers()[0];
    if (!canvasLayer) return;
    const selectedIds = selected?.kind === 'group' ? descendantImages(selected.id) : contentSelectionIds;
    const selectedLayers = doc.layers.filter(item => selectedIds.includes(item.id) && item.kind === 'image' && effectivelyVisible(item));
    if (selectedLayers.length < 1 || (selected?.kind !== 'group' && selectedLayers.length < 2)) return;
    const x = Math.min(...selectedLayers.map(item => item.x)), y = Math.min(...selectedLayers.map(item => item.y));
    const right = Math.max(...selectedLayers.map(item => item.x + item.width)), bottom = Math.max(...selectedLayers.map(item => item.y + item.height));
    const bounds: Bounds = { x, y, width: right - x, height: bottom - y };
    const frame = new Konva.Rect({ ...bounds, stroke: '#b6f04a', strokeWidth: 2, fill: 'rgba(182,240,74,.035)', draggable: true });
    const transformer = new Konva.Transformer({ nodes: [frame], rotateEnabled: false, keepRatio: ratioLocked, flipEnabled: false, borderStroke: '#b6f04a', borderStrokeWidth: 2, anchorSize: 10, anchorStroke: '#d9ff86', anchorStrokeWidth: 1, anchorFill: '#b6f04a', anchorCornerRadius: 1 });
    const toolbarWidth = 88 / view.z, toolbarHeight = 34 / view.z;
    const toolbar = new Konva.Group({ x: bounds.x + bounds.width / 2 - toolbarWidth / 2, y: bounds.y - toolbarHeight - 8 / view.z, scaleX: 1 / view.z, scaleY: 1 / view.z });
    toolbar.add(new Konva.Rect({ width: 88, height: 34, fill: '#151815', stroke: '#343b31', strokeWidth: 1, cornerRadius: 7, shadowColor: '#000', shadowBlur: 8, shadowOpacity: .32 }));
    toolbar.add(new Konva.Text({ text: '▦  编组', x: 12, y: 8, fill: '#e9f5de', fontSize: 17, fontStyle: 'bold' }));
    toolbar.visible(selected?.kind !== 'group');
    const overallLabelText = `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;
    const overallOutline = new Konva.Text({ text: overallLabelText, fontSize: 17 / view.z, fontStyle: 'bold', fill: '#101510', stroke: '#101510', strokeWidth: 2.4 / view.z, shadowColor: '#000', shadowBlur: 2 / view.z, shadowOpacity: .72 });
    const overallText = new Konva.Text({ text: overallLabelText, fontSize: 17 / view.z, fontStyle: 'bold', fill: '#ffffff' });
    const overallLabel = new Konva.Group({ x: bounds.x + bounds.width / 2 - overallText.width() / 2, y: bounds.y + bounds.height + 14 / view.z, listening: false });
    overallLabel.add(overallOutline, overallText);
    const imageNodes = new Map<string, Konva.Image>();
    canvasLayer.find('Image').forEach(node => { const layerId = node.id(); if (layerId) imageNodes.set(layerId, node as Konva.Image); });
    const syncFrameVisuals = () => {
      const dx = frame.x() - bounds.x, dy = frame.y() - bounds.y;
      selectedLayers.forEach(item => { const node = imageNodes.get(item.id); if (node) { node.x(item.x + dx); node.y(item.y + dy); } const label = liveLabels.current.get(item.id); if (label) label.position({ x: item.x + dx + item.width / 2 - labelTextWidth(label) / 2, y: item.y + dy + item.height + 14 / view.z }); });
      toolbar.position({ x: frame.x() + bounds.width / 2 - toolbarWidth / 2, y: frame.y() - toolbarHeight - 8 / view.z });
      overallLabel.position({ x: frame.x() + frame.width() / 2 - labelTextWidth(overallLabel) / 2, y: frame.y() + frame.height() + 14 / view.z });
      canvasLayer.batchDraw();
    };
    frame.on('mousedown touchstart dragstart', event => { event.cancelBubble = true; });
    frame.on('dragmove', syncFrameVisuals);
    frame.on('dragend', event => { event.cancelBubble = true; moveMultiSelection(Math.round(frame.x() - bounds.x), Math.round(frame.y() - bounds.y)); frame.position({ x: bounds.x, y: bounds.y }); canvasLayer.batchDraw(); });
    frame.on('transform', () => {
      const sx = frame.scaleX(), sy = frame.scaleY();
      selectedLayers.forEach(item => { const node = imageNodes.get(item.id); if (node) { node.x(frame.x() + (item.x - bounds.x) * sx); node.y(frame.y() + (item.y - bounds.y) * sy); node.width(item.width * sx); node.height(item.height * sy); } const label = liveLabels.current.get(item.id); if (label) { const labelText = `${Math.round(item.width * sx)} × ${Math.round(item.height * sy)}`; label.find('Text').forEach(text => (text as Konva.Text).text(labelText)); label.position({ x: frame.x() + (item.x - bounds.x) * sx + item.width * sx / 2 - labelTextWidth(label) / 2, y: frame.y() + (item.y - bounds.y) * sy + item.height * sy + 14 / view.z }); } });
      toolbar.position({ x: frame.x() + bounds.width * sx / 2 - toolbarWidth / 2, y: frame.y() - toolbarHeight - 8 / view.z });
      const scaledWidth = bounds.width * sx, scaledHeight = bounds.height * sy, scaledText = `${Math.round(scaledWidth)} × ${Math.round(scaledHeight)}`;
      overallLabel.find('Text').forEach(text => (text as Konva.Text).text(scaledText));
      overallLabel.position({ x: frame.x() + scaledWidth / 2 - labelTextWidth(overallLabel) / 2, y: frame.y() + scaledHeight + 14 / view.z });
      canvasLayer.batchDraw();
    });
    frame.on('transformend', event => { event.cancelBubble = true; const sx = frame.scaleX(), sy = frame.scaleY(), x = frame.x(), y = frame.y(); scaleMultiSelection(bounds, x, y, sx, sy); frame.scale({ x: 1, y: 1 }); frame.position({ x, y }); frame.size({ width: bounds.width * sx, height: bounds.height * sy }); canvasLayer.batchDraw(); });
    toolbar.on('click tap', event => { event.cancelBubble = true; groupSelectedLayers(); });
    canvasLayer.add(frame, transformer, overallLabel, toolbar); canvasLayer.batchDraw();
    return () => { frame.destroy(); transformer.destroy(); overallLabel.destroy(); toolbar.destroy(); canvasLayer.batchDraw(); };
  }, [contentSelectionIds, selectedId, doc.layers, ratioLocked, size.width, size.height, view.z]);
  useEffect(() => {
    if (!selected || selected.kind !== 'image') return;
    const stage = Konva.stages.find(candidate => Boolean(host.current && host.current.contains(candidate.container())));
    const canvasLayer = stage?.getLayers()[0];
    if (!canvasLayer) return;
    const label = `${Math.round(selected.width)} × ${Math.round(selected.height)}`, fixedFontSize = 17 / view.z;
    const outline = new Konva.Text({ text: label, fontSize: fixedFontSize, fontStyle: 'bold', fill: '#101510', stroke: '#101510', strokeWidth: 2.4 / view.z, shadowColor: '#000', shadowBlur: 2 / view.z, shadowOpacity: .72 });
    const text = new Konva.Text({ text: label, fontSize: fixedFontSize, fontStyle: 'bold', fill: '#ffffff' });
    const group = new Konva.Group({ x: selected.x + selected.width / 2 - text.width() / 2, y: selected.y + selected.height + 14 / view.z, listening: false });
    group.add(outline, text); canvasLayer.add(group); liveLabels.current.set(selected.id, group); canvasLayer.batchDraw();
    return () => { liveLabels.current.delete(selected.id); group.destroy(); canvasLayer.batchDraw(); };
  }, [selectedId, doc.layers, size.width, size.height, view.z]);
  useEffect(() => {
    if (!selected || selected.kind !== 'image' || !selected.visible) return;
    const stage = Konva.stages.find(candidate => Boolean(host.current && host.current.contains(candidate.container()))), canvasLayer = stage?.getLayers()[0];
    if (!canvasLayer) return;
    const width = 168 / view.z, height = 38 / view.z, group = new Konva.Group({ x: selected.x + selected.width / 2 - width / 2, y: selected.y - height - 10 / view.z, scaleX: 1 / view.z, scaleY: 1 / view.z });
    group.add(new Konva.Rect({ width: 168, height: 38, fill: '#111711', stroke: '#41553b', strokeWidth: 1, cornerRadius: 9, shadowColor: '#000', shadowBlur: 10, shadowOpacity: .38 }));
    group.add(new Konva.Text({ text: '✦  AI 智能拆分', x: 16, y: 10, fill: '#b6f04a', fontSize: 17, fontStyle: 'bold' }));
    group.on('click tap', event => { event.cancelBubble = true; setSmartSplitOpen(true); });
    const syncToolbar = () => { const node = stage.findOne(`#${selected.id}`) as Konva.Image | undefined; if (!node) return; const widthNow = node.width() * node.scaleX(), heightNow = node.height() * node.scaleY(); group.position({ x: node.x() + widthNow / 2 - width / 2, y: node.y() - height - 10 / view.z }); canvasLayer.batchDraw(); };
    stage.on('dragmove.ai-toolbar transform.ai-toolbar', syncToolbar);
    canvasLayer.add(group); canvasLayer.batchDraw();
    return () => { stage.off('.ai-toolbar'); group.destroy(); canvasLayer.batchDraw(); };
  }, [selectedId, doc.layers, size.width, size.height, view.z]);
  useEffect(() => {
    const workspace = host.current, layersPanel = document.querySelector<HTMLElement>('.layers-panel');
    if (!workspace || !layersPanel) return;
    layersPanel.querySelectorAll('.resource-browser').forEach(item => item.remove());
    const ownedChildren = Array.from(layersPanel.children) as HTMLElement[];
    const bar = document.createElement('nav'); bar.className = 'canvas-command-bar';
    const resources = document.createElement('section'); resources.className = 'resource-browser'; resources.hidden = true;
    const showLayers = () => { layerViewMode.current = 'layers'; layersPanel.classList.remove('show-resources'); resources.hidden = true; ownedChildren.forEach(item => { item.style.display = ''; }); bar.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.mode === 'layers')); };
    const showResources = () => { layerViewMode.current = 'resources'; layersPanel.classList.add('show-resources'); ownedChildren.forEach(item => { item.style.display = 'none'; }); resources.hidden = false; bar.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.mode === 'resources')); };
    const makeButton = (label: string, mode?: 'layers' | 'resources', action?: () => void) => { const button = document.createElement('button'); button.textContent = label; if (mode) button.dataset.mode = mode; button.addEventListener('click', () => { if (mode === 'layers') showLayers(); if (mode === 'resources') showResources(); action?.(); }); return button; };
    bar.append(makeButton('▦  图层', 'layers'), makeButton('▧  资源', 'resources'), makeButton('✦  AI', undefined, () => setTab('ai')), makeButton('⇩  导入', undefined, () => file.current?.click()), makeButton('⇧  导出', undefined, () => void exportPsd(doc).catch(error => setNotice(error.message))), makeButton('⚒  工具箱', undefined, () => setNotice('工具箱功能将在下一版开放。')), makeButton('↗  分享', undefined, () => setNotice('分享链接功能将在下一版开放。')));
    const assets = doc.layers.filter(layer => layer.kind === 'image' && layer.source);
    const header = document.createElement('div'); header.className = 'resource-header'; header.innerHTML = '<div class="resource-title"><b>▧</b><span><small>资源库</small>资源</span></div><button class="pin">⚑</button><div class="resource-search">⌕&nbsp; 搜索资源...</div><div class="resource-tabs"><button class="active">2D 图片</button></div>';
    const controls = document.createElement('div'); controls.className = 'resource-controls'; controls.innerHTML = `<span>(${assets.length})</span><div><button title="缩略图网格">▦</button><button title="列表">☷</button><button title="添加资源">＋</button></div>`;
    const content = document.createElement('div'); content.className = 'resource-grid';
    const renderAssets = (list = false) => { content.classList.toggle('list', list); content.replaceChildren(); assets.forEach(layer => { const card = document.createElement('button'); card.className = 'asset-card'; const image = document.createElement('img'); image.src = layer.source!; image.alt = layer.name; const name = document.createElement('strong'); name.textContent = layer.name; const meta = document.createElement('small'); meta.textContent = `${Math.round(layer.width)} × ${Math.round(layer.height)}`; card.append(image, name, meta); card.addEventListener('click', () => { setSelectedId(layer.id); }); content.append(card); }); if (!assets.length) content.innerHTML = '<p class="resource-empty">导入图片或 PSD 后，资源会显示在这里。</p>'; };
    renderAssets();
    const controlButtons = controls.querySelectorAll<HTMLButtonElement>('button'); controlButtons[0]?.addEventListener('click', () => renderAssets(false)); controlButtons[1]?.addEventListener('click', () => renderAssets(true)); controlButtons[2]?.addEventListener('click', () => file.current?.click());
    resources.append(header, controls, content); layersPanel.append(resources); workspace.append(bar); if (layerViewMode.current === 'resources') showResources(); else showLayers();
    return () => { bar.remove(); resources.remove(); layersPanel.classList.remove('show-resources'); ownedChildren.forEach(item => { item.style.display = ''; }); };
  }, [doc.layers]);
  useEffect(() => {
    document.querySelectorAll<HTMLLabelElement>('.dimension-row label, .dimension-row + .property-grid label').forEach(label => {
      if (label.dataset.inlineField) return;
      const input = label.querySelector('input');
      const caption = Array.from(label.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())?.textContent?.trim();
      if (!input || !caption) return;
      Array.from(label.childNodes).forEach(node => { if (node.nodeType === Node.TEXT_NODE) node.textContent = ''; });
      const prefix = document.createElement('span'); prefix.className = 'field-inline-label'; prefix.textContent = caption;
      label.insertBefore(prefix, input); label.dataset.inlineField = 'true';
    });
  }, [selectedId, doc.layers]);
  useEffect(() => {
    const section = Array.from(document.querySelectorAll<HTMLElement>('.properties section')).find(item => item.querySelector('h4')?.textContent === '位置');
    const grid = section?.querySelector<HTMLElement>('.property-grid'); if (!section || !grid || !selected) return;
    section.querySelectorAll('.position-alignments,.position-transforms').forEach(item => item.remove());
    const alignments = document.createElement('div'); alignments.className = 'position-alignments';
    const actions: Array<[string, string, Parameters<typeof alignLayers>[0]]> = [['左对齐', '┤', 'left'], ['水平居中', '╫', 'centerX'], ['右对齐', '├', 'right'], ['水平等距', '↔', 'spaceX'], ['顶对齐', '⊥', 'top'], ['垂直居中', '═', 'centerY'], ['底对齐', '⊤', 'bottom'], ['垂直等距', '↕', 'spaceY']];
    actions.forEach(([title, icon, mode]) => { const button = document.createElement('button'); button.title = title; button.textContent = icon; button.addEventListener('click', () => alignLayers(mode)); alignments.append(button); });
    const transforms = document.createElement('div'); transforms.className = 'position-transforms';
    const transformActions: Array<[string, string, 'flipX' | 'flipY' | 'rotate90']> = [['水平翻转', '⇋', 'flipX'], ['垂直翻转', '⇵', 'flipY'], ['顺时针旋转 90°', '↻ 90°', 'rotate90']];
    transformActions.forEach(([title, icon, mode]) => { const button = document.createElement('button'); button.title = title; button.textContent = icon; button.disabled = selected.kind !== 'image'; button.addEventListener('click', () => transformSelectedBitmap(mode)); transforms.append(button); });
    section.insertBefore(alignments, grid); grid.insertAdjacentElement('afterend', transforms);
    return () => { alignments.remove(); transforms.remove(); };
  }, [selectedId, contentSelectionIds, doc.layers]);
  const renderLayerRows = (parentId: string | null, depth = 0): ReactNode[] => doc.layers.filter(layer => layer.parentId === parentId).sort((a, b) => a.zIndex - b.zIndex).flatMap(layer => {
    const isCollapsed = collapsedGroups.includes(layer.id), isSelected = layer.id === selectedId || contentSelectionIds.includes(layer.id);
    const row = <div key={layer.id} className={`layer-row ${isSelected ? 'selected' : ''}`} data-layer-id={layer.id} draggable onClick={() => selectLayer(layer)} style={{ paddingLeft: `${7 + depth * 18}px` }}>
      {layer.kind === 'group' ? <button className="layer-toggle" aria-label={isCollapsed ? '展开组' : '收起组'} onClick={event => { event.stopPropagation(); setCollapsedGroups(groups => isCollapsed ? groups.filter(id => id !== layer.id) : [...groups, layer.id]); }}>{isCollapsed ? '▸' : '▾'}</button> : <span className="layer-toggle" />}
      <span className="layer-icon">{layer.kind === 'selection' ? '◇' : layer.kind === 'group' ? '▦' : '▣'}</span><span className="layer-name">{layer.name}</span>
      <span className="layer-actions" onClick={event => event.stopPropagation()}><button aria-label={layer.visible ? '隐藏' : '显示'} onClick={() => patch(layer.id, { visible: !layer.visible })}><VisibilityIcon visible={layer.visible} /></button><button aria-label={layer.locked ? '解锁' : '锁定'} onClick={() => patch(layer.id, { locked: !layer.locked })}>{layer.locked ? '⌁' : '⌑'}</button></span>
    </div>;
    return [row, ...(layer.kind === 'group' && !isCollapsed ? renderLayerRows(layer.id, depth + 1) : [])];
  });
  return <div className="app-shell" onClick={() => setMenu(null)}><header><div className="brand"><b>LC</b><strong>Layer Canvas</strong><span>FIRST EDITION</span></div><div className="toolbar"><button onClick={() => file.current?.click()}>导入图片</button><button disabled={!doc.layers.length} onClick={addSelection}>新建选区</button><button disabled={selected?.kind !== 'selection'} onClick={extract}>提取选区</button></div><div className="exports"><button onClick={() => exportJson(doc)}>导出 JSON</button><button disabled={!doc.layers.length} onClick={() => exportPsd(doc).catch(e => setNotice(e.message))}>导出 PSD</button><button disabled={!doc.layers.length} onClick={() => exportUnityZip(doc)}>Unity 包</button></div></header><input ref={file} type="file" accept="image/*" hidden onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} /><main><aside className="layers-panel"><div className="panel-title"><div><small className="micro">工作区</small><span>图层</span></div><button className="pin">⚑</button></div><div className="scene-heading"><span>场景 <b>{scenes.length}</b></span><button onClick={() => addPage(scene.id)}>＋</button></div><div className="scene-search">⌕ 搜索场景...</div><div className="page-list">{scenes.map(s => <div key={s.id}><div className="scene-name">▦ {s.name}<button onClick={() => addPage(s.id)}>＋</button></div>{s.pages.map(p => <button key={p.id} className={`page-row ${p.id === page.id ? 'active' : ''}`} onClick={() => choose(s.id, p.id)} onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, s: s.id, p: p.id }); }}>▦ {p.name}</button>)}</div>)}</div><div className="layer-search">⌕ 搜索图层...</div><div className="tree">{renderLayerRows(null)}</div></aside><section className="workspace" ref={host} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files[0]); }}><div className="notice">{notice}</div><Stage width={size.width} height={size.height} x={view.x} y={view.y} scaleX={view.z} scaleY={view.z} draggable onDragEnd={e => setView(v => ({ ...v, x: e.target.x(), y: e.target.y() }))} onWheel={wheel}><Layer><Group>{ordered.map(l => l.kind === 'group' ? null : <Sprite key={l.id} layer={effectivelyVisible(l) ? l : { ...l, visible: false }} selected={l.id === selectedId} keepRatio={ratioLocked} select={() => selectLayer(l)} patch={v => patch(l.id, v)} sync={syncLiveLayer} />)}</Group></Layer></Stage><div className="zoom">{Math.round(view.z * 100)}% · 滚轮缩放 · 拖动画布</div></section><aside className="inspector"><div className="tabs"><button className={tab === 'design' ? 'active' : ''} onClick={() => setTab('design')}>设计</button><button className={tab === 'note' ? 'active' : ''} onClick={() => setTab('note')}>笔记</button><button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI</button></div>{tab === 'design' && (selected ? <div className="properties"><div className="object-title"><select disabled><option>{selected.kind}</option></select><b>{selected.name}</b></div><div className="inline-toggles"><label>可见性 <input type="checkbox" checked={selected.visible} onChange={() => patch(selected.id, { visible: !selected.visible })} /></label><label>锁定 <button onClick={() => patch(selected.id, { locked: !selected.locked })}>{selected.locked ? '⌁' : '⌑'}</button></label></div><section><h4>位置</h4><div className="property-grid">{field('X', 'x', selected.x)}{field('Y', 'y', selected.y)}{field('旋转', 'rotation', selected.rotation || 0)}{field('层级', 'zIndex', selected.zIndex)}</div></section><section><h4>布局</h4><div className="dimension-row"><label>W<input type="number" value={selected.width} onChange={e => resize('width', +e.target.value)} /></label><button type="button" className={`ratio-lock ${ratioLocked ? 'locked' : ''}`} title={ratioLocked ? '解锁宽高比例' : '锁定宽高比例'} aria-label={ratioLocked ? '解锁宽高比例' : '锁定宽高比例'} onClick={() => setRatioLocked(x => !x)}>🔗</button><label>H<input type="number" value={selected.height} onChange={e => resize('height', +e.target.value)} /></label></div><div className="property-grid">{field('圆角', 'radius', selected.radius || 0)}<label>不透明度<input type="number" value={Math.round((selected.opacity ?? 1) * 100)} onChange={e => patch(selected.id, { opacity: +e.target.value / 100 })} /></label></div></section><details><summary>自动布局 <span>＋</span></summary><p>第一版保留绝对坐标。</p></details><details open><summary>填充 <span>＋</span></summary><label className="color-row"><input type="color" value={selected.fill || '#ffffff'} onChange={e => patch(selected.id, { fill: e.target.value })} /><input value={selected.fill || '#FFFFFF'} onChange={e => patch(selected.id, { fill: e.target.value })} /><span>{Math.round((selected.opacity ?? 1) * 100)}%</span></label></details><details><summary>图像调整 <span>›</span></summary><p>后续接入调整与局部重绘。</p></details><details><summary>约束 <span>›</span></summary></details><details><summary>描边 <span>＋</span></summary></details><details><summary>效果 <span>＋</span></summary></details></div> : <div className="empty inspector-empty">从画布或左侧图层<br />选择一个对象</div>)}{tab === 'note' && <div className="properties note-panel"><h3>{selected?.name || 'Page 笔记'}</h3><textarea disabled={!selected} value={selected?.note || ''} placeholder="记录功能逻辑、修改意见或交付说明…" onChange={e => selected && patch(selected.id, { note: e.target.value })} /></div>}{tab === 'ai' && <div className="properties ai-panel"><div className="ai-mark">✦</div><h3>AI 拆分</h3><p>AI 返回的 PNG、坐标和名称会写入当前 Page 的图层树。</p><button onClick={() => setNotice('AI Provider 尚未接入；当前可使用选区提取。')}>配置 AI 拆分</button></div>}</aside></main>{menu && <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}><button onClick={() => { rename(menu.s, menu.p); setMenu(null); }}>重命名</button><button onClick={() => { copy(menu.s, menu.p); setMenu(null); }}>创建副本</button><hr /><button className="danger" onClick={() => { drop(menu.s, menu.p); setMenu(null); }}>删除</button></div>}</div>;
}
