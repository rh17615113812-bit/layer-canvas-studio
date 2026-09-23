import { useEffect, useMemo, useRef, useState } from 'react';
import type { LayerNode } from './types';
import { DEFAULT_VISION_INSTRUCTION } from './smartSplit';
import type { LocalComfyConfig } from './localComfy';
import type { RunningHubConfig } from './runningHub';

export type SmartSplitBox = { id: string; name: string; type: 'ui' | 'text'; bbox: [number, number, number, number]; confidence?: number; shouldSplit?: boolean; thumbnail?: string };
export type SplitMode = 'api' | 'local' | 'runninghub';
type WorkflowConfig = LocalComfyConfig | RunningHubConfig;
type Props = { image: LayerNode; onCancel: () => void; onStart: (boxes: SmartSplitBox[], mode: SplitMode, config?: WorkflowConfig) => Promise<void> };
type Direction = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type Pan = { x: number; y: number };
type RunningHubNodeCandidate = { id: string; label: string; fieldName?: string; score: number };
const uid = () => crypto.randomUUID().replaceAll('-', '');
const defaultPan = (): Pan => ({ x: 0, y: 0 });
const readString = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const detectRunningHubConfig = (value: unknown) => {
  const nodes = new Map<string, RunningHubNodeCandidate>();
  let workflowId = '';
  const visit = (item: unknown, depth = 0) => {
    if (!item || typeof item !== 'object' || depth > 12) return;
    if (Array.isArray(item)) { item.forEach(entry => visit(entry, depth + 1)); return; }
    const record = item as Record<string, unknown>;
    workflowId ||= readString(record.workflowId || record.workflow_id || record.apiId || record.api_id);
    const id = readString(record.nodeId || record.node_id || ((record.inputs || record.outputs || record.class_type || record.nodeType) && record.id));
    if (id) {
      const label = readString(record.title || record.name || record.label || record.class_type || record.nodeType || record.type) || `节点 ${id}`;
      const fieldName = readString(record.fieldName || record.field_name || record.inputName || record.input_name) || undefined;
      const hint = `${label} ${fieldName || ''} ${JSON.stringify(record).slice(0, 600)}`.toLowerCase();
      const score = /image|img|upload|loadimage|picture|图片|图像/.test(hint) ? 2 : /input|输入/.test(hint) ? 1 : 0;
      const previous = nodes.get(id);
      if (!previous || score > previous.score) nodes.set(id, { id, label, fieldName, score });
    }
    Object.values(record).forEach(entry => visit(entry, depth + 1));
  };
  visit(value);
  return { workflowId, nodes: [...nodes.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)) };
};
const clampBox = (box: [number, number, number, number], width: number, height: number): [number, number, number, number] => {
  const l = Math.max(0, Math.min(width - 2, Math.round(Math.min(box[0], box[2]))));
  const t = Math.max(0, Math.min(height - 2, Math.round(Math.min(box[1], box[3]))));
  const r = Math.max(l + 2, Math.min(width, Math.round(Math.max(box[0], box[2]))));
  const b = Math.max(t + 2, Math.min(height, Math.round(Math.max(box[1], box[3]))));
  return [l, t, r, b];
};

export default function SmartSplitWorkspace({ image, onCancel, onStart }: Props) {
  const imageRef = useRef<HTMLImageElement>(null), viewportRef = useRef<HTMLDivElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const panning = useRef<{ x: number; y: number; origin: Pan } | null>(null);
  const action = useRef<{ id: string; direction?: Direction; mode: 'move' | 'resize'; x: number; y: number; box: [number, number, number, number] } | null>(null);
  const actionBefore = useRef<SmartSplitBox[] | null>(null);
  const [natural, setNatural] = useState({ width: image.assetWidth || image.width, height: image.assetHeight || image.height });
  const [zoom, setZoom] = useState(1), [display, setDisplay] = useState({ width: 640, height: 360 });
  const [pan, setPan] = useState<Pan>(defaultPan);
  const [boxes, setBoxes] = useState<SmartSplitBox[]>([]), [undo, setUndo] = useState<SmartSplitBox[][]>([]), [redo, setRedo] = useState<SmartSplitBox[][]>([]);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [instruction, setInstruction] = useState(DEFAULT_VISION_INSTRUCTION);
  const [mode, setMode] = useState<SplitMode>('api');
  const [configOpen, setConfigOpen] = useState(false);
  const [comfyUrl, setComfyUrl] = useState(() => localStorage.getItem('layer-canvas-comfy-url') || 'http://127.0.0.1:8188');
  const [workflow, setWorkflow] = useState<Record<string, unknown> | undefined>();
  const [workflowName, setWorkflowName] = useState('使用服务端配置');
  const [inputNodeId, setInputNodeId] = useState(() => localStorage.getItem('layer-canvas-comfy-input-node') || '');
  const [outputNodeIds, setOutputNodeIds] = useState(() => localStorage.getItem('layer-canvas-comfy-output-nodes') || '');
  const [runningHubWorkflowId, setRunningHubWorkflowId] = useState(() => localStorage.getItem('layer-canvas-runninghub-workflow-id') || '2101886414299426818');
  const [runningHubInputNodeId, setRunningHubInputNodeId] = useState(() => localStorage.getItem('layer-canvas-runninghub-input-node') || '');
  const [runningHubInputFieldName, setRunningHubInputFieldName] = useState(() => localStorage.getItem('layer-canvas-runninghub-input-field') || 'image');
  const [runningHubOutputNodeIds, setRunningHubOutputNodeIds] = useState(() => localStorage.getItem('layer-canvas-runninghub-output-nodes') || '');
  const [runningHubInstanceType, setRunningHubInstanceType] = useState<'default' | 'plus' | 'ultra'>(() => (localStorage.getItem('layer-canvas-runninghub-instance') as 'default' | 'plus' | 'ultra') || 'default');
  const [runningHubAddMetadata, setRunningHubAddMetadata] = useState(() => localStorage.getItem('layer-canvas-runninghub-metadata') === 'true');
  const [runningHubPersonalQueue, setRunningHubPersonalQueue] = useState(() => localStorage.getItem('layer-canvas-runninghub-personal-queue') === 'true');
  const [runningHubWorkflowName, setRunningHubWorkflowName] = useState('未选择 AI 应用配置');
  const [runningHubNodes, setRunningHubNodes] = useState<RunningHubNodeCandidate[]>([]);
  const [runningHubNodeSearch, setRunningHubNodeSearch] = useState('');
  useEffect(() => { const img = imageRef.current; if (!img) return; const load = () => setNatural({ width: img.naturalWidth || image.width, height: img.naturalHeight || image.height }); if (img.complete) load(); else img.onload = load; return () => { img.onload = null; }; }, [image.source, image.width, image.height]);
  const fit = () => { setZoom(Math.min(Math.max(320, window.innerWidth * .84) / natural.width, Math.max(260, window.innerHeight - 300) / natural.height, 1)); setPan(defaultPan()); };
  useEffect(() => { fit(); const resize = () => fit(); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, [natural.width, natural.height]);
  useEffect(() => setDisplay({ width: natural.width * zoom, height: natural.height * zoom }), [natural.width, natural.height, zoom]);
  const scale = display.width / natural.width || 1;
  const normalized = useMemo(() => boxes.filter(box => box.id !== '__draft'), [boxes]);
  const point = (event: React.PointerEvent) => { const rect = viewportRef.current!.getBoundingClientRect(); return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }; };
  const commit = (before: SmartSplitBox[], after: SmartSplitBox[]) => { if (JSON.stringify(before) === JSON.stringify(after)) return; setUndo(history => [...history, before]); setRedo([]); };
  const replace = (next: SmartSplitBox[], before = boxes) => { commit(before, next); setBoxes(next); };
  const beginDraw = (event: React.PointerEvent) => {
    if ((event.button === 1 || event.button === 2) && !(event.target as HTMLElement).closest('[data-box]')) {
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      panning.current = { x: event.clientX, y: event.clientY, origin: pan }; return;
    }
    if (event.button !== 0 || !viewportRef.current?.contains(event.target as Node) || (event.target as HTMLElement).closest('[data-box]')) return;
    event.currentTarget.setPointerCapture(event.pointerId); drawing.current = point(event);
  };
  const movePan = (event: React.PointerEvent) => { const current = panning.current; if (!current) return; setPan({ x: current.origin.x + event.clientX - current.x, y: current.origin.y + event.clientY - current.y }); };
  const moveDraw = (event: React.PointerEvent) => { if (!drawing.current) return; const p = point(event), bbox = clampBox([drawing.current.x, drawing.current.y, p.x, p.y], natural.width, natural.height); setBoxes(current => { const draft = current.find(box => box.id === '__draft'); return draft ? current.map(box => box.id === '__draft' ? { ...box, bbox } : box) : [...current, { id: '__draft', name: '', type: 'ui', shouldSplit: true, bbox }]; }); };
  const endDraw = () => { if (!drawing.current) return; drawing.current = null; setBoxes(current => { const draft = current.find(box => box.id === '__draft'); const prior = current.filter(box => box.id !== '__draft'); if (!draft || draft.bbox[2] - draft.bbox[0] < 4 || draft.bbox[3] - draft.bbox[1] < 4) return prior; const created = { ...draft, id: uid(), name: `区域 ${prior.length + 1}` }; setSelectedBoxId(created.id); setUndo(history => [...history, prior]); setRedo([]); return [...prior, created]; }); };
  const beginAction = (event: React.PointerEvent, box: SmartSplitBox, mode: 'move' | 'resize', direction?: Direction) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); const p = point(event); action.current = { id: box.id, mode, direction, x: p.x, y: p.y, box: box.bbox }; actionBefore.current = boxes; };
  const moveAction = (event: React.PointerEvent) => { const current = action.current; if (!current) return; const p = point(event), dx = p.x - current.x, dy = p.y - current.y, [l, t, r, b] = current.box; let next: [number, number, number, number]; if (current.mode === 'move') { const mx = Math.max(-l, Math.min(natural.width - r, dx)), my = Math.max(-t, Math.min(natural.height - b, dy)); next = [l + mx, t + my, r + mx, b + my]; } else { const d = current.direction!, values: [number, number, number, number] = [l, t, r, b]; if (d.includes('w')) values[0] = Math.max(0, Math.min(r - 2, l + dx)); if (d.includes('e')) values[2] = Math.min(natural.width, Math.max(l + 2, r + dx)); if (d.includes('n')) values[1] = Math.max(0, Math.min(b - 2, t + dy)); if (d.includes('s')) values[3] = Math.min(natural.height, Math.max(t + 2, b + dy)); next = clampBox(values, natural.width, natural.height); } setBoxes(items => items.map(item => item.id === current.id ? { ...item, bbox: next } : item)); };
  const endAction = () => { if (action.current && actionBefore.current) commit(actionBefore.current, boxes); action.current = null; actionBefore.current = null; };
  const cancelPointer = () => { drawing.current = null; panning.current = null; action.current = null; actionBefore.current = null; setBoxes(items => items.filter(item => item.id !== '__draft')); };
  const remove = (id: string) => { if (!boxes.some(box => box.id === id)) return; replace(boxes.filter(box => box.id !== id)); };
  const autoBox = async () => { setBusy(true); setError(''); try { const response = await fetch('http://127.0.0.1:8787/api/vision/boxes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: image.source, ...(mode === "runninghub" ? {} : { instruction }), metadata: natural }) }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || '视觉定位失败'); const found = Array.isArray(body.boxes) ? body.boxes : []; const next = found.map((box: { title?: string; name?: string; type?: string; bbox?: number[]; confidence?: number; should_split?: boolean; shouldSplit?: boolean }, index: number) => ({ id: uid(), name: box.title || box.name || `区域 ${index + 1}`, type: box.type === 'text' ? 'text' as const : 'ui' as const, shouldSplit: box.type === 'text' ? false : box.should_split ?? box.shouldSplit ?? true, bbox: clampBox((box.bbox || [0, 0, natural.width, natural.height]) as [number, number, number, number], natural.width, natural.height), confidence: box.confidence })); replace(next); setSelectedBoxId(next.at(-1)?.id ?? null); if (!found.length) setError('AI 未找到可独立编辑的元素，请手动框选。'); } catch (cause) { setError(cause instanceof Error ? cause.message : '视觉定位失败，请检查服务端配置。'); } finally { setBusy(false); } };
  const undoBoxes = () => { const before = undo.at(-1); if (!before) return; setUndo(history => history.slice(0, -1)); setRedo(history => [...history, boxes]); setBoxes(before); };
  const redoBoxes = () => { const next = redo.at(-1); if (!next) return; setRedo(history => history.slice(0, -1)); setUndo(history => [...history, boxes]); setBoxes(next); };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (configOpen || target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      const key = event.key.toLowerCase(), modifier = event.ctrlKey || event.metaKey;
      if (modifier && key === 'z') {
        event.preventDefault(); event.stopPropagation();
        if (event.shiftKey || event.altKey) redoBoxes(); else undoBoxes();
        return;
      }
      if (modifier && key === 'y') { event.preventDefault(); event.stopPropagation(); redoBoxes(); return; }
      if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); if (selectedBoxId) remove(selectedBoxId); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [boxes, configOpen, redo, selectedBoxId, undo]);
  const loadWorkflow = async (file?: File) => { if (!file) return; setError(''); try { const parsed = JSON.parse(await file.text()); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('工作流 JSON 格式无效。'); setWorkflow(parsed as Record<string, unknown>); setWorkflowName(file.name); } catch (cause) { setWorkflow(undefined); setWorkflowName('使用服务端配置'); setError(cause instanceof Error ? cause.message : '无法读取工作流 JSON。'); } };
  const loadRunningHubWorkflow = async (file?: File) => { if (!file) return; setError(''); try { const parsed = JSON.parse(await file.text()); if (!parsed || typeof parsed !== 'object') throw new Error('RunningHub 工作流节点映射 JSON 格式无效。'); const detected = detectRunningHubConfig(parsed); setRunningHubWorkflowName(file.name); setRunningHubNodes(detected.nodes); if (detected.workflowId) setRunningHubWorkflowId(detected.workflowId); const preferred = detected.nodes.find(node => node.score === 2) || detected.nodes[0]; if (preferred) { setRunningHubInputNodeId(preferred.id); if (preferred.fieldName) setRunningHubInputFieldName(preferred.fieldName); } if (!detected.nodes.length) setError('未在该 JSON 中发现节点 ID；请确认这是工作流节点映射文件，或手动填写节点 ID。'); } catch (cause) { setRunningHubWorkflowName('未选择工作流节点映射'); setRunningHubNodes([]); setError(cause instanceof Error ? cause.message : '无法读取 RunningHub 节点映射 JSON。'); } };
  const start = async () => { if (mode !== 'api' && !normalized.length) { setError(`${mode === 'local' ? '本地' : 'RunningHub'}拆分不会返回坐标，请先手动框选或使用 AI 自动框选。`); return; } setBusy(true); setError(''); try { localStorage.setItem('layer-canvas-comfy-url', comfyUrl); localStorage.setItem('layer-canvas-comfy-input-node', inputNodeId); localStorage.setItem('layer-canvas-comfy-output-nodes', outputNodeIds); localStorage.setItem('layer-canvas-runninghub-workflow-id', runningHubWorkflowId); localStorage.setItem('layer-canvas-runninghub-input-node', runningHubInputNodeId); localStorage.setItem('layer-canvas-runninghub-input-field', runningHubInputFieldName); localStorage.setItem('layer-canvas-runninghub-output-nodes', runningHubOutputNodeIds); localStorage.setItem('layer-canvas-runninghub-instance', runningHubInstanceType); localStorage.setItem('layer-canvas-runninghub-metadata', String(runningHubAddMetadata)); localStorage.setItem('layer-canvas-runninghub-personal-queue', String(runningHubPersonalQueue)); const config = mode === 'local' ? { comfyUrl, workflow, inputNodeId: inputNodeId.trim() || undefined, outputNodeIds: outputNodeIds.split(',').map(value => value.trim()).filter(Boolean) } : mode === 'runninghub' ? { workflowId: runningHubWorkflowId.trim() || undefined, inputNodeId: runningHubInputNodeId.trim() || undefined, inputFieldName: runningHubInputFieldName.trim() || undefined, outputNodeIds: runningHubOutputNodeIds.split(',').map(value => value.trim()).filter(Boolean), instanceType: runningHubInstanceType, addMetadata: runningHubAddMetadata, usePersonalQueue: runningHubPersonalQueue } : undefined; await onStart(normalized.map((box, index) => ({ ...box, name: box.name.trim() || `区域 ${index + 1}` })), mode, config); } catch (cause) { setError(cause instanceof Error ? cause.message : '图层拆分失败，请重试。'); } finally { setBusy(false); } };
  const handles: Direction[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const stage = <div className="smart-split-canvas-area" onContextMenu={event => event.preventDefault()} onWheel={event => { event.preventDefault(); setZoom(current => Math.max(.15, Math.min(2, current + (event.deltaY < 0 ? .1 : -.1)))); }} onPointerDown={beginDraw} onPointerMove={event => { movePan(event); moveDraw(event); moveAction(event); }} onPointerUp={() => { panning.current = null; endDraw(); endAction(); }} onPointerCancel={cancelPointer}><div className="smart-split-stage-wrap"><div ref={viewportRef} className={`smart-split-stage${panning.current ? ' is-panning' : ''}`} style={{ width: display.width, height: display.height, transform: `translate(${pan.x}px, ${pan.y}px)` }}><img ref={imageRef} src={image.source} alt={image.name} draggable={false} /><div className="smart-split-boxes">{boxes.map((box, index) => { const [left, top, right, bottom] = box.bbox; return <div key={box.id} data-box className={`smart-split-box${selectedBoxId === box.id ? ' is-selected' : ''}`} style={{ left: left * scale, top: top * scale, width: (right - left) * scale, height: (bottom - top) * scale }}><b onPointerDown={event => { setSelectedBoxId(box.id); beginAction(event, box, 'move'); }}>{index + 1}</b>{handles.map(direction => <i key={direction} className={`smart-split-resize handle-${direction}`} onPointerDown={event => { setSelectedBoxId(box.id); beginAction(event, box, 'resize', direction); }} />)}</div>; })}</div></div></div></div>;
  const localSettings = <div className="smart-split-local-settings"><label><span>ComfyUI 地址</span><input value={comfyUrl} onChange={event => setComfyUrl(event.target.value)} placeholder="http://127.0.0.1:8188" /></label><label><span>API 工作流 JSON</span><span className="smart-split-workflow"><input type="file" accept=".json,application/json" onChange={event => void loadWorkflow(event.target.files?.[0])} /><b>{workflowName}</b></span></label><label><span>输入节点 ID（可选）</span><input value={inputNodeId} onChange={event => setInputNodeId(event.target.value)} placeholder="自动查找 LoadImage" /></label><label><span>输出节点 ID（可选，逗号分隔）</span><input value={outputNodeIds} onChange={event => setOutputNodeIds(event.target.value)} placeholder="自动收集所有图片输出" /></label></div>;
  const filteredRunningHubNodes = runningHubNodes.filter(node => `${node.id} ${node.label}`.toLowerCase().includes(runningHubNodeSearch.trim().toLowerCase()));
  const chooseRunningHubNode = (node: RunningHubNodeCandidate) => { setRunningHubInputNodeId(node.id); if (node.fieldName) setRunningHubInputFieldName(node.fieldName); };
  const runningHubSettings = <div className="smart-split-local-settings smart-split-runninghub-settings"><p className="smart-split-config-note">此页调用 RunningHub ComfyUI 工作流 API。API Key 只从本机服务端 .env.local 读取，不会保存到浏览器。</p><label className="smart-split-config-upload"><span>工作流节点映射 JSON（可选）</span><span className="smart-split-workflow"><input type="file" accept=".json,application/json" onChange={event => void loadRunningHubWorkflow(event.target.files?.[0])} /><b>{runningHubWorkflowName}</b></span></label><label><span>工作流 API ID</span><input value={runningHubWorkflowId} onChange={event => setRunningHubWorkflowId(event.target.value)} placeholder="2101886414299426818" /></label><label><span>图片输入节点 ID（可选）</span><input value={runningHubInputNodeId} onChange={event => setRunningHubInputNodeId(event.target.value)} placeholder="上传 JSON 后自动识别，亦可手动填写" /></label><label><span>图片字段名</span><input value={runningHubInputFieldName} onChange={event => setRunningHubInputFieldName(event.target.value)} placeholder="image" /></label><label><span>输出节点 ID（可选，逗号分隔）</span><input value={runningHubOutputNodeIds} onChange={event => setRunningHubOutputNodeIds(event.target.value)} placeholder="留空取第一个图片结果" /></label><label><span>运行实例</span><select value={runningHubInstanceType} onChange={event => setRunningHubInstanceType(event.target.value as 'default' | 'plus' | 'ultra')}><option value="default">default · 24G</option><option value="plus">plus · 48G</option><option value="ultra">ultra · 84G</option></select></label><div className="smart-split-runninghub-options"><label><input type="checkbox" checked={runningHubAddMetadata} onChange={event => setRunningHubAddMetadata(event.target.checked)} />输出附带工作流元数据</label><label><input type="checkbox" checked={runningHubPersonalQueue} onChange={event => setRunningHubPersonalQueue(event.target.checked)} />使用个人独占队列</label></div>{runningHubNodes.length > 0 && <section className="smart-split-node-picker"><header><b>识别到 {runningHubNodes.length} 个节点</b><input value={runningHubNodeSearch} onChange={event => setRunningHubNodeSearch(event.target.value)} placeholder="搜索节点 ID 或名称" /></header><div>{filteredRunningHubNodes.map(node => <button type="button" className={node.id === runningHubInputNodeId ? 'active' : ''} key={node.id} onClick={() => chooseRunningHubNode(node)}><b>{node.id}</b><span>{node.label}</span>{node.score === 2 && <em>图片候选</em>}</button>)}</div></section>}</div>;
  const firstPanel = <>
    <div className="smart-split-compact-header">
      {mode === 'local' ? <button className="smart-split-config-button" onClick={() => setConfigOpen(true)}>⚙ 本地配置</button> : mode === 'runninghub' ? <button className="smart-split-config-button" onClick={() => setConfigOpen(true)}>⚙ RunningHub 配置</button> : <h2>AI 智能分层 · 框选元素</h2>}
      <button className="smart-split-ai" onClick={autoBox} disabled={busy}>✦ {busy ? '识别中…' : `AI 自动框选${normalized.length ? ` (${normalized.length})` : ''}`}</button>
    </div>
    {mode === 'api' && <p className="smart-split-compact-help">在图片上拖拽框选；拖动左上角标题可移动，框内可继续画新框，八方向控制点可调整大小。选中框后按 Delete 删除，可用 Ctrl+Z / Ctrl+Y 撤销和重做。</p>}
    {mode !== 'runninghub' && <details className="smart-split-advanced">
      <summary>识别提示词</summary>
      <label className="smart-split-instruction"><textarea value={instruction} onChange={event => setInstruction(event.target.value)} /><button type="button" onClick={() => setInstruction(DEFAULT_VISION_INSTRUCTION)}>恢复默认</button></label>
    </details>}
    <small className="smart-split-error">{error}</small>
    <div className="smart-split-footer smart-split-compact-footer">
      <span>{normalized.length ? `已选择 ${normalized.length} 个区域` : mode === 'api' ? '未框选：将使用模型自动拆分' : '请至少框选一个区域'}</span>
      <div><button onClick={onCancel}>取消</button><button className="smart-split-primary" disabled={busy || (mode !== 'api' && !normalized.length)} onClick={() => normalized.length ? setStep(2) : void start()}>{busy ? '拆分中…' : normalized.length ? '下一步' : mode === 'api' ? '自动拆分' : '请先框选'}</button></div>
    </div>
  </>;
  const secondPanel = <><div className="smart-split-count">区域 {normalized.length}</div><div className="smart-split-layer-list">{normalized.map((box, index) => { const [left, top, right, bottom] = box.bbox, cropW = right - left, cropH = bottom - top; return <div className="smart-split-layer-row" key={box.id}><span className="smart-split-handle">☷</span><b>{index + 1}</b><div className="smart-split-thumb"><img src={image.source} alt="" style={{ width: `${50 * natural.width / cropW}px`, height: `${34 * natural.height / cropH}px`, left: `${-50 * left / cropW}px`, top: `${-34 * top / cropH}px` }} /></div><input value={box.name} onChange={event => replace(boxes.map(item => item.id === box.id ? { ...item, name: event.target.value } : item))} /><select value={box.type} onChange={event => replace(boxes.map(item => item.id === box.id ? { ...item, type: event.target.value as 'ui' | 'text', shouldSplit: event.target.value === 'text' ? false : item.shouldSplit ?? true } : item))}><option value="ui">UI 元素</option><option value="text">程序文字</option></select>{box.type === 'text' ? <span className="smart-split-nonsplit">程序字（不拆分）</span> : <label className="smart-split-split-toggle"><input type="checkbox" checked={box.shouldSplit !== false} onChange={event => replace(boxes.map(item => item.id === box.id ? { ...item, shouldSplit: event.target.checked } : item))} />拆分</label>}<button disabled={index === 0} onClick={() => { const next = [...boxes]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; replace(next); }}>↑</button><button disabled={index === normalized.length - 1} onClick={() => { const next = [...boxes]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; replace(next); }}>↓</button></div>; })}</div><small className="smart-split-error">{error}</small><div className="smart-split-footer"><button onClick={() => setStep(1)}>上一步</button><button className="smart-split-primary" disabled={busy} onClick={start}>{busy ? '分层中…' : '开始分层'}</button></div></>;
  const activate = (next: SplitMode) => { setMode(next); setStep(1); setConfigOpen(false); setError(''); };
  const modeTitle = mode === 'api' ? 'API 拆分' : mode === 'local' ? '本地拆分' : 'RunningHub 工作流拆分';
  return <div className="smart-split-overlay"><div className="smart-split-topbar"><button onClick={undoBoxes} disabled={!undo.length}>↶ 撤销</button><button onClick={redoBoxes} disabled={!redo.length}>↷ 重做</button><button onClick={() => setZoom(z => Math.max(.15, z - .1))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(z => Math.min(2, z + .1))}>＋</button><button onClick={fit}>适应</button><button onClick={onCancel}>关闭</button></div>{stage}<div className={`smart-split-panel ${mode !== 'api' ? 'smart-split-panel-local' : ''}`}><div className="smart-split-panel-layout"><nav className="smart-split-mode-tabs" aria-label="拆分方式"><button className={mode === 'api' ? 'active' : ''} onClick={() => activate('api')}>API 拆分</button><button className={mode === 'local' ? 'active' : ''} onClick={() => activate('local')}>本地拆分</button><button className={mode === 'runninghub' ? 'active' : ''} onClick={() => activate('runninghub')}>RunningHub</button></nav><section className="smart-split-panel-content">{step === 1 ? firstPanel : <><h2>{modeTitle} · 配置图层</h2>{secondPanel}</>}</section></div></div>{configOpen && mode !== 'api' && <div className="smart-split-config-overlay" role="dialog" aria-modal="true" aria-label={`${modeTitle}配置`}><section className="smart-split-config-dialog"><header><h2>{modeTitle}配置</h2><button onClick={() => setConfigOpen(false)} aria-label="关闭配置">×</button></header>{mode === 'local' ? localSettings : runningHubSettings}<footer><button className="smart-split-primary" onClick={() => setConfigOpen(false)}>完成</button></footer></section></div>}</div>;
}
