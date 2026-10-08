import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Group,
  Image as KImage,
  Layer,
  Rect,
  Stage,
  Text as KText,
  Transformer,
} from "react-konva";
import Konva from "konva";
import { createAlignmentIcon } from "./alignmentIcons";
import { editorReducer } from "./documentHistory";
import { extractSelectionCanvas } from "./bitmapGeometry";
import { fitTextLayer } from "./textLayout";
import { applyTextOverlay, placeTextLayers, textLayersFromBoxes } from "./textRecognition";
const PsdExportDialog = lazy(() => import("./PsdExportDialog"));
const exportJson = async (...args: Parameters<typeof import("./exports").exportJson>) => (await import("./exports")).exportJson(...args);
const exportEngineZip = async (...args: Parameters<typeof import("./engineExports").exportEngineZip>) => (await import("./engineExports")).exportEngineZip(...args);
import { seedreamLayerSplit } from "./seedream";
const importPsd = async (file: File) => (await import("./psdImport")).importPsd(file);
import SmartSplitWorkspace, {
  type SmartSplitBox,
  type SplitMode,
} from "./SmartSplitWorkspace";
import { pixelToNormalizedBBox } from "./coordinates";
import { selectSplittableBoxes } from "./smartSplit";
import {
  localComfyLayerSplit,
  type LocalComfyConfig,
} from "./localComfy";
import { runningHubLayerSplit, type RunningHubConfig } from "./runningHub";
import type { Artboard, DocumentState, LayerNode, PageState, SceneState, TextLayerStyle } from "./types";
import {
  assignLayerToArtboard as assignLayerDocumentToArtboard,
  artboardContainingPoint,
  artboardForLayer,
  documentBounds,
  fitArtboardView,
  nextArtboardOrigin,
  removeArtboard,
  resizeArtboard,
  translateArtboard,
} from "./artboards";
import {
  assignLayerBatchToArtboard,
  rangeLayerSelection,
  removeLayerBatch,
  reorderLayerBatch,
  toggleLayerSelection,
  type InsertPosition,
} from "./layerOrder";
import {
  clearWorkspace,
  loadWorkspace,
  saveWorkspace,
  workspaceSnapshotVersion,
} from "./workspacePersistence";

const uid = () => crypto.randomUUID().replaceAll("-", "");
const empty = (): DocumentState => ({
  version: "1.0",
  canvas: { width: 1, height: 1 },
  artboards: [],
  layers: [],
});
const newPage = (name: string): PageState => ({
  id: uid(),
  name,
  document: empty(),
});

const addSplitComparisonArtboard = (
  current: DocumentState,
  sourceArtboard: Artboard,
  sourceLayer: LayerNode,
  resultLayers: LayerNode[],
  imageWidth: number,
  imageHeight: number,
  ids: { artboard: Artboard },
) => {
  const artboard = ids.artboard;
  const baseZ = Math.max(-1, ...current.layers.map((layer) => layer.zIndex)) + 1;
  const scaleX = sourceLayer.width / imageWidth;
  const scaleY = sourceLayer.height / imageHeight;
  const offsetX = sourceLayer.x - sourceArtboard.x;
  const offsetY = sourceLayer.y - sourceArtboard.y;
  const placed = resultLayers.map(layer => {
    const textPlacement = layer.kind === "text" ? placeTextLayers([layer], sourceLayer, imageWidth, imageHeight)[0] : undefined;
    return {
      ...layer,
      ...(textPlacement ?? {}),
      artboardId: artboard.id,
      x: textPlacement ? artboard.x + textPlacement.x - sourceArtboard.x : artboard.x + offsetX + layer.x * scaleX,
      y: textPlacement ? artboard.y + textPlacement.y - sourceArtboard.y : artboard.y + offsetY + layer.y * scaleY,
      width: textPlacement?.width ?? layer.width * scaleX,
      height: textPlacement?.height ?? layer.height * scaleY,
      zIndex: baseZ + 1 + (layer.kind === "text" ? Math.max(0, ...resultLayers.map(item => item.zIndex)) + 1 : 0) + Math.max(0, layer.zIndex),
    };
  });
  const artboards = [...current.artboards, artboard];
  return {
    document: {
      ...current,
      canvas: documentBounds(artboards),
      artboards,
      layers: [...current.layers, ...placed],
    },
    artboard,
    placed,
  };
};

const comparisonViewport = (
  sourceArtboard: Artboard,
  comparisonArtboard: Artboard,
  viewport: { width: number; height: number },
) => {
  const left = Math.min(sourceArtboard.x, comparisonArtboard.x);
  const top = Math.min(sourceArtboard.y, comparisonArtboard.y);
  const right = Math.max(
    sourceArtboard.x + sourceArtboard.width,
    comparisonArtboard.x + comparisonArtboard.width,
  );
  const bottom = Math.max(
    sourceArtboard.y + sourceArtboard.height,
    comparisonArtboard.y + comparisonArtboard.height,
  );
  const width = right - left;
  const height = bottom - top;
  const z = Math.max(
    0.05,
    Math.min(1, (viewport.width - 100) / width, (viewport.height - 150) / height),
  );
  return {
    z,
    x: (viewport.width - width * z) / 2 - left * z,
    y: (viewport.height - height * z) / 2 - top * z,
  };
};
function useBitmap(source?: string) {
  const [image, setImage] = useState<HTMLImageElement>();
  useEffect(() => {
    if (!source) {
      setImage(undefined);
      return;
    }
    const next = new Image();
    next.onload = () => setImage(next);
    next.src = source;
  }, [source]);
  return image;
}
function VisibilityIcon({ visible }: { visible: boolean }) {
  return (
    <svg className="visibility-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2.5 12s3.4-5 9.5-5 9.5 5 9.5 5-3.4 5-9.5 5-9.5-5-9.5-5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      {visible ? (
        <circle cx="12" cy="12" r="2.6" fill="currentColor" />
      ) : (
        <path
          d="m4 4 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg className="lock-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="5"
        y="10"
        width="14"
        height="11"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d={locked ? "M8 10V7a4 4 0 0 1 8 0v3" : "M16 10V7a4 4 0 0 0-7.7-1.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="15" r="1.5" fill="currentColor" />
    </svg>
  );
}
const labelTextWidth = (group: Konva.Group) => {
  const texts = group.find("Text");
  return texts.length
    ? (texts[texts.length - 1] as Konva.Text).width()
    : group.getClientRect({ skipTransform: true }).width;
};

function Sprite({
  layer,
  selected,
  keepRatio,
  hover,
  select,
  patch,
  drop,
  sync,
}: {
  layer: LayerNode;
  selected: boolean;
  keepRatio: boolean;
  hover: (id: string | null) => void;
  select: (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  patch: (v: Partial<LayerNode>) => void;
  drop: (x: number, y: number) => void;
  sync: (id: string, node: Konva.Image) => void;
}) {
  const image = useBitmap(layer.source);
  const ref = useRef<Konva.Image>(null);
  const selectBeforeDrag = (
    event: Konva.KonvaEventObject<MouseEvent | TouchEvent>,
  ) => {
    event.cancelBubble = true;
    const pointer = event.evt as MouseEvent;
    const modified = pointer.ctrlKey || pointer.metaKey || pointer.shiftKey;
    if (modified) {
      select(event);
      event.target.stopDrag();
    } else if (!selected) {
      select(event);
    }
  };
  if (!layer.visible) return null;
  if (layer.kind === "selection")
    return (
      <Rect
        x={layer.x}
        y={layer.y}
        width={layer.width}
        height={layer.height}
        stroke="#b6f04a"
        dash={[8, 5]}
        fill="rgba(182,240,74,.08)"
        draggable={!layer.locked}
        onMouseEnter={() => hover(layer.id)}
        onMouseLeave={() => hover(null)}
        onMouseDown={selectBeforeDrag}
        onTouchStart={selectBeforeDrag}
        onDragStart={(e) => {
          e.cancelBubble = true;
        }}
        onDragEnd={(e) => {
          e.cancelBubble = true;
          drop(Math.round(e.target.x()), Math.round(e.target.y()));
        }}
      />
    );
  if (layer.kind === "group") return null;
  if (layer.kind === "text") {
    const style = layer.textStyle;
    const fitted = fitTextLayer(layer);
    return (
      <KText
        id={layer.id}
        x={layer.x}
        y={layer.y}
        width={fitted.width}
        height={fitted.height}
        rotation={layer.rotation || 0}
        opacity={layer.opacity ?? 1}
        text={layer.textContent || ""}
        fontFamily={style?.fontFamily || "Arial"}
        fontSize={style?.fontSize || 24}
        fontStyle={`${style?.bold ? "bold " : ""}${style?.italic ? "italic" : ""}`.trim() || "normal"}
        fill={style?.color || "#ffffff"}
        stroke={style?.strokeColor}
        strokeWidth={style?.strokeWidth || 0}
        align={style?.align || "left"}
        verticalAlign={style?.verticalAlign || "top"}
        lineHeight={style?.lineHeight || 1.2}
        letterSpacing={style?.letterSpacing || 0}
        wrap="none"
        draggable={!layer.locked}
        onMouseEnter={() => hover(layer.id)}
        onMouseLeave={() => hover(null)}
        onMouseDown={selectBeforeDrag}
        onTouchStart={selectBeforeDrag}
        onDragStart={(e) => { e.cancelBubble = true; }}
        onDragEnd={(e) => {
          e.cancelBubble = true;
          drop(Math.round(e.target.x()), Math.round(e.target.y()));
        }}
        onTransformEnd={(event) => {
          const node = event.target as Konva.Text;
          const scale = Math.sqrt(Math.abs(node.scaleX() * node.scaleY()));
          patch({
            x: Math.round(node.x()),
            y: Math.round(node.y()),
            rotation: Math.round(node.rotation()),
            textStyle: {
              ...style,
              fontSize: Math.max(2, Math.round((style?.fontSize || 24) * scale)),
            },
          });
          node.scale({ x: 1, y: 1 });
        }}
      />
    );
  }
  return (
    <>
      <KImage
        id={layer.id}
        ref={ref}
        image={image}
        x={layer.x}
        y={layer.y}
        width={layer.width}
        height={layer.height}
        rotation={layer.rotation || 0}
        opacity={layer.opacity ?? 1}
        draggable={!layer.locked}
        onMouseEnter={() => hover(layer.id)}
        onMouseLeave={() => hover(null)}
        onMouseDown={selectBeforeDrag}
        onTouchStart={selectBeforeDrag}
        onDragStart={(e) => {
          e.cancelBubble = true;
        }}
        onDragMove={() => {
          if (ref.current) {
            sync(layer.id, ref.current);
          }
        }}
        onDragEnd={(e) => {
          e.cancelBubble = true;
          drop(Math.round(e.target.x()), Math.round(e.target.y()));
        }}
        onTransformEnd={() => {
          const node = ref.current!;
          patch({
            x: Math.round(node.x()),
            y: Math.round(node.y()),
            width: Math.max(2, Math.round(layer.width * node.scaleX())),
            height: Math.max(2, Math.round(layer.height * node.scaleY())),
            rotation: Math.round(node.rotation()),
          });
          node.scale({ x: 1, y: 1 });
        }}
      />
    </>
  );
}

function FloatingImageTransformer({
  layer,
  keepRatio,
  viewScale,
}: {
  layer: LayerNode;
  keepRatio: boolean;
  viewScale: number;
}) {
  const transformer = useRef<Konva.Transformer>(null);
  useEffect(() => {
    const stage = Konva.stages.find((candidate) =>
      Boolean(candidate.findOne(`#${layer.id}`)),
    );
    const node = stage?.findOne(`#${layer.id}`) as Konva.Image | undefined;
    if (!node || !transformer.current) return;
    transformer.current.nodes([node]);
    transformer.current.getLayer()?.batchDraw();
  }, [layer.id, layer.x, layer.y, layer.width, layer.height, keepRatio]);
  if (layer.locked || !layer.visible) return null;
  return (
    <Transformer
      ref={transformer}
      rotateEnabled
      keepRatio={keepRatio}
      flipEnabled={false}
      borderStroke="#b6f04a"
      borderStrokeWidth={2}
      anchorSize={6}
      anchorStyleFunc={(anchor) => anchor.hitStrokeWidth(18 / viewScale)}
      anchorStroke="#d9ff86"
      anchorStrokeWidth={1}
      anchorFill="#b6f04a"
      anchorCornerRadius={1}
    />
  );
}

function FloatingTextTransformer({ layer, viewScale }: { layer: LayerNode; viewScale: number }) {
  const transformer = useRef<Konva.Transformer>(null);
  useEffect(() => {
    const stage = Konva.stages.find((candidate) =>
      Boolean(candidate.findOne(`#${layer.id}`)),
    );
    const node = stage?.findOne(`#${layer.id}`) as Konva.Text | undefined;
    if (!node || !transformer.current) return;
    transformer.current.nodes([node]);
    transformer.current.getLayer()?.batchDraw();
  }, [layer.id, layer.x, layer.y, layer.width, layer.height, layer.rotation, layer.textContent, layer.textStyle]);
  if (layer.locked || !layer.visible) return null;
  return (
    <Transformer
      ref={transformer}
      rotateEnabled
      keepRatio
      flipEnabled={false}
      borderStroke="#b6f04a"
      borderStrokeWidth={2}
      anchorSize={6}
      anchorStyleFunc={(anchor) => anchor.hitStrokeWidth(18 / viewScale)}
      anchorStroke="#d9ff86"
      anchorStrokeWidth={1}
      anchorFill="#b6f04a"
      anchorCornerRadius={1}
      boundBoxFunc={(oldBox, newBox) =>
        Math.abs(newBox.width) < 16 || Math.abs(newBox.height) < 16
          ? oldBox
          : newBox
      }
    />
  );
}

function ArtboardCanvas({
  artboard,
  selected,
  viewScale,
  select,
  resize,
  children,
}: {
  artboard: DocumentState["artboards"][number];
  selected: boolean;
  viewScale: number;
  select: () => void;
  resize: (bounds: Bounds) => void;
  children: ReactNode;
}) {
  const frame = useRef<Konva.Rect>(null),
    transformer = useRef<Konva.Transformer>(null);
  useEffect(() => {
    if (!selected || !frame.current || !transformer.current) return;
    transformer.current.nodes([frame.current]);
    transformer.current.getLayer()?.batchDraw();
  }, [selected, artboard.x, artboard.y, artboard.width, artboard.height]);
  return (
    <>
      <Rect
        ref={frame}
        x={artboard.x}
        y={artboard.y}
        width={artboard.width}
        height={artboard.height}
        fill="#202620"
        shadowColor="#000"
        shadowBlur={18}
        shadowOpacity={0.35}
        onMouseDown={(event) => {
          event.cancelBubble = true;
          select();
        }}
        onTouchStart={(event) => {
          event.cancelBubble = true;
          select();
        }}
        onTransformEnd={(event) => {
          event.cancelBubble = true;
          const node = frame.current!;
          resize({
            x: node.x(),
            y: node.y(),
            width: artboard.width * node.scaleX(),
            height: artboard.height * node.scaleY(),
          });
          node.scale({ x: 1, y: 1 });
        }}
      />
      <Group
        clipX={artboard.x}
        clipY={artboard.y}
        clipWidth={artboard.width}
        clipHeight={artboard.height}
      >
        {children}
      </Group>
      {selected && (
        <Transformer
          ref={transformer}
          rotateEnabled={false}
          keepRatio={false}
          flipEnabled={false}
          borderEnabled={false}
          anchorSize={6}
          anchorStyleFunc={(anchor) => anchor.hitStrokeWidth(18 / viewScale)}
          anchorStroke="#d9ff86"
          anchorStrokeWidth={1}
          anchorFill="#b6f04a"
          anchorCornerRadius={1}
          boundBoxFunc={(oldBox, newBox) =>
            Math.abs(newBox.width) < 32 || Math.abs(newBox.height) < 32
              ? oldBox
              : newBox
          }
        />
      )}
    </>
  );
}

function CanvasGroupFrame({
  group,
  children,
  selected,
  viewScale,
  select,
  hover,
  move,
  resize,
}: {
  group: LayerNode;
  children: LayerNode[];
  selected: boolean;
  viewScale: number;
  select: (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  hover: (id: string | null) => void;
  move: (dx: number, dy: number) => void;
  resize: (bounds: Bounds) => void;
}) {
  const frame = useRef<Konva.Rect>(null),
    transformer = useRef<Konva.Transformer>(null);
  useEffect(() => {
    if (!selected || !frame.current || !transformer.current) return;
    transformer.current.nodes([frame.current]);
    transformer.current.getLayer()?.batchDraw();
  }, [selected, group.x, group.y, group.width, group.height]);
  if (!group.visible) return null;
  const titleHeight = 18 / viewScale,
    titleWidth = Math.min(group.width, 220 / viewScale),
    titleY = group.y - titleHeight - 4 / viewScale;
  const syncChildren = (dx: number, dy: number) => {
    const stage = frame.current?.getStage();
    children.forEach((child) => {
      const node = stage?.findOne(`#${child.id}`);
      node?.position({ x: child.x + dx, y: child.y + dy });
    });
    frame.current?.position({ x: group.x + dx, y: group.y + dy });
    transformer.current?.forceUpdate();
    frame.current?.getLayer()?.batchDraw();
  };
  const selectBeforeDrag = (
    event: Konva.KonvaEventObject<MouseEvent | TouchEvent>,
  ) => {
    event.cancelBubble = true;
    const pointer = event.evt as MouseEvent;
    const modified = pointer.ctrlKey || pointer.metaKey || pointer.shiftKey;
    if (modified) {
      select(event);
      event.target.stopDrag();
    } else if (!selected) {
      select(event);
    }
  };
  return (
    <>
      <Rect
        ref={frame}
        x={group.x}
        y={group.y}
        width={group.width}
        height={group.height}
        stroke={selected ? "#b6f04a" : "#5d7659"}
        strokeWidth={(selected ? 1.5 : 1) / viewScale}
        dash={[6 / viewScale, 4 / viewScale]}
        listening={false}
        onTransformEnd={(event) => {
          event.cancelBubble = true;
          const node = frame.current!;
          resize({
            x: node.x(),
            y: node.y(),
            width: group.width * node.scaleX(),
            height: group.height * node.scaleY(),
          });
          node.scale({ x: 1, y: 1 });
        }}
      />
      <Group
        x={group.x}
        y={titleY}
        draggable={!group.locked}
        onMouseEnter={() => hover(group.id)}
        onMouseLeave={() => hover(null)}
        onMouseDown={selectBeforeDrag}
        onTouchStart={selectBeforeDrag}
        onDragStart={(event) => {
          event.cancelBubble = true;
        }}
        onDragMove={(event) => {
          event.cancelBubble = true;
          syncChildren(
            event.currentTarget.x() - group.x,
            event.currentTarget.y() - titleY,
          );
        }}
        onDragEnd={(event) => {
          event.cancelBubble = true;
          const dx = event.currentTarget.x() - group.x,
            dy = event.currentTarget.y() - titleY;
          syncChildren(0, 0);
          event.currentTarget.position({ x: group.x, y: titleY });
          move(dx, dy);
        }}
      >
        <Rect width={titleWidth} height={titleHeight} fill="rgba(0,0,0,0.001)" />
        <KText
          x={2 / viewScale}
          y={3 / viewScale}
          width={titleWidth - 4 / viewScale}
          text={`▦ ${group.name}`}
          fill={selected ? "#b6f04a" : "#8fdc86"}
          fontSize={11 / viewScale}
          ellipsis
          wrap="none"
        />
      </Group>
      {selected && !group.locked && (
        <Transformer
          ref={transformer}
          rotateEnabled={false}
          keepRatio={false}
          flipEnabled={false}
          borderEnabled={false}
          anchorSize={6}
          anchorStyleFunc={(anchor) => anchor.hitStrokeWidth(18 / viewScale)}
          anchorStroke="#d9ff86"
          anchorStrokeWidth={1}
          anchorFill="#b6f04a"
          anchorCornerRadius={1}
          boundBoxFunc={(oldBox, newBox) =>
            Math.abs(newBox.width) < 16 || Math.abs(newBox.height) < 16
              ? oldBox
              : newBox
          }
        />
      )}
    </>
  );
}

type Bounds = { x: number; y: number; width: number; height: number };

export default function App() {
  const file = useRef<HTMLInputElement>(null),
    host = useRef<HTMLDivElement>(null),
    importedArtboardToFocus = useRef<string | null>(null),
    suppressTreeClick = useRef(false),
    treeSelectionAnchor = useRef<string | null>(null),
    saveTimer = useRef<number | undefined>(undefined),
    liveLabels = useRef(new Map<string, Konva.Group>()),
    layerViewMode = useRef<"layers" | "resources">("layers");
  const initial = { id: uid(), name: "场景 1", pages: [newPage("Page 1")] };
  const [editor, dispatchEditor] = useReducer(editorReducer, { scenes: [initial], histories: {} });
  const scenes = editor.scenes;
  const setScenes = (change: SceneState[] | ((scenes: SceneState[]) => SceneState[]), resetHistory = false) => dispatchEditor({ type: "scenes", change, resetHistory });
  const
    [sceneId, setSceneId] = useState(initial.id),
    [pageId, setPageId] = useState(initial.pages[0].id),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [hoveredLayerId, setHoveredLayerId] = useState<string | null>(null),
    [selectedArtboardId, setSelectedArtboardId] = useState<string | null>(null),
    [view, setView] = useState({ x: 80, y: 80, z: 0.5 }),
    [size, setSize] = useState({ width: 900, height: 700 }),
    [tab, setTab] = useState<"design" | "note" | "ai">("design"),
    [ratioLocked, setRatioLocked] = useState(true),
    [notice, setNotice] = useState(
      "在场景中创建 Page；每个 Page 都拥有独立画布与图层。",
    ),
    [menu, setMenu] = useState<{
      x: number;
      y: number;
      s: string;
      p: string;
    } | null>(null),
    [splitting, setSplitting] = useState(false),
    [smartSplitOpen, setSmartSplitOpen] = useState(false),
    [psdExportRequest, setPsdExportRequest] = useState<{ document: DocumentState; artboardId?: string; groupId?: string } | null>(null),
    [workspaceReady, setWorkspaceReady] = useState(false);
  const [contentSelectionIds, setContentSelectionIds] = useState<string[]>([]),
    [collapsedGroups, setCollapsedGroups] = useState<string[]>([]),
    [collapsedArtboards, setCollapsedArtboards] = useState<string[]>([]);
  const scene = scenes.find((s) => s.id === sceneId)!,
    page = scene.pages.find((p) => p.id === pageId)!,
    doc = page.document,
    selected = doc.layers.find((l) => l.id === selectedId),
    activeArtboard =
      doc.artboards.find((item) => item.id === selectedArtboardId) ??
      artboardForLayer(doc, selected),
    ordered = useMemo(
      () => [...doc.layers].sort((a, b) => a.zIndex - b.zIndex),
      [doc.layers],
    );
  const openPsdExport = (groupId?: string) => {
    if (!activeArtboard && !groupId) return setNotice('请先选择可导出的画板。');
    setPsdExportRequest({ document: doc, artboardId: activeArtboard?.id, groupId });
  };
  useEffect(() => {
    let active = true;
    void loadWorkspace()
      .then((snapshot) => {
        if (!active || !snapshot) return;
        setScenes(snapshot.scenes);
        setSceneId(snapshot.sceneId);
        setPageId(snapshot.pageId);
        setView(snapshot.view);
        setCollapsedGroups(snapshot.collapsedGroups);
        setCollapsedArtboards(snapshot.collapsedArtboards);
        setNotice("已恢复上次保存的本地工作区。");
      })
      .catch(() => {
        if (active) setNotice("浏览器本地工作区无法恢复；已使用新的空工作区。");
      })
      .finally(() => {
        if (active) setWorkspaceReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!workspaceReady) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveWorkspace({
        version: workspaceSnapshotVersion,
        scenes,
        sceneId,
        pageId,
        view,
        collapsedGroups,
        collapsedArtboards,
      }).catch(() => setNotice("本地自动保存失败：请检查浏览器存储空间。"));
    }, 400);
    return () => window.clearTimeout(saveTimer.current);
  }, [workspaceReady, scenes, sceneId, pageId, view, collapsedGroups, collapsedArtboards]);
  const resetSavedWorkspace = () => {
    if (!window.confirm("清除浏览器保存的工作区，并恢复为空白画布吗？此操作不会删除已导出的文件。")) return;
    window.clearTimeout(saveTimer.current);
    void clearWorkspace()
      .then(() => {
        const next = { id: uid(), name: "场景 1", pages: [newPage("Page 1")] };
        setScenes([next], true);
        setSceneId(next.id);
        setPageId(next.pages[0].id);
        setSelectedId(null);
        setSelectedArtboardId(null);
        setContentSelectionIds([]);
        setCollapsedGroups([]);
        setCollapsedArtboards([]);
        setView({ x: 80, y: 80, z: 0.5 });
        setNotice("已清除保存的工作区，并恢复为空白画布。");
      })
      .catch(() => setNotice("无法清除浏览器保存的工作区。"));
  };
  const descendants = (parentId: string): LayerNode[] =>
    doc.layers
      .filter((layer) => layer.parentId === parentId)
      .flatMap((layer) => [
        layer,
        ...(layer.kind === "group" ? descendants(layer.id) : []),
      ]);
  const descendantImages = (parentId: string) =>
    descendants(parentId)
      .filter((layer) => layer.kind === "image")
      .map((layer) => layer.id);
  const effectivelyVisible = (layer: LayerNode) => {
    let current: LayerNode | undefined = layer;
    while (current) {
      if (!current.visible) return false;
      current = current.parentId
        ? doc.layers.find((item) => item.id === current!.parentId)
        : undefined;
    }
    return true;
  };
  const hoveredLayer = hoveredLayerId
    ? doc.layers.find(
        (layer) => layer.id === hoveredLayerId && effectivelyVisible(layer),
      )
    : undefined;
  const hoveredLayerBounds = hoveredLayer ? fitTextLayer(hoveredLayer) : undefined;
  const setLayerSelection = (ids: string[], primaryId: string | null) => {
    const uniqueIds = [...new Set(ids)].filter((id) =>
      doc.layers.some((layer) => layer.id === id),
    );
    const nextPrimary =
      primaryId && uniqueIds.includes(primaryId)
        ? primaryId
        : uniqueIds.at(-1) ?? null;
    setSelectedId(nextPrimary);
    setContentSelectionIds(uniqueIds.length > 1 ? uniqueIds : []);
    const selectedBoards = [
      ...new Set(
        doc.layers
          .filter((layer) => uniqueIds.includes(layer.id))
          .map((layer) => layer.artboardId)
          .filter(Boolean),
      ),
    ];
    setSelectedArtboardId(
      selectedBoards.length === 1 ? selectedBoards[0]! : null,
    );
    setDoc(
      (current) => ({
        ...current,
        layers: current.layers.map((item) => ({
          ...item,
          boxSelected:
            item.kind === "image" && uniqueIds.includes(item.id),
        })),
      }),
      false,
    );
  };
  const visibleTreeLayerIds = () => {
    const collect = (
      parentId: string | null,
      artboardId: string | null,
    ): string[] =>
      doc.layers
        .filter(
          (layer) =>
            layer.parentId === parentId &&
            (artboardId === null
              ? !layer.artboardId
              : layer.artboardId === artboardId),
        )
        .sort((a, b) => a.zIndex - b.zIndex)
        .flatMap((layer) => [
          layer.id,
          ...(layer.kind === "group" && !collapsedGroups.includes(layer.id)
            ? collect(layer.id, artboardId)
            : []),
        ]);
    return [
      ...doc.artboards.flatMap((artboard) =>
        collapsedArtboards.includes(artboard.id)
          ? []
          : collect(null, artboard.id),
      ),
      ...collect(null, null),
    ];
  };
  const selectLayer = (
    layer: LayerNode,
    modifiers?: { toggle?: boolean; range?: boolean },
  ) => {
    if (modifiers?.range) {
      if (treeSelectionAnchor.current) {
        const visibleIds = visibleTreeLayerIds();
        setLayerSelection(
          rangeLayerSelection(visibleIds, treeSelectionAnchor.current, layer.id),
          layer.id,
        );
        return;
      }
      const currentIds =
        selected?.kind === "group" && !contentSelectionIds.includes(selected.id)
          ? [selected.id]
          : contentSelectionIds.length > 1
            ? contentSelectionIds
            : selectedId
              ? [selectedId]
              : [];
      const nextIds = currentIds.includes(layer.id)
        ? currentIds
        : [...currentIds, layer.id];
      treeSelectionAnchor.current = selectedId ?? layer.id;
      setLayerSelection(nextIds, layer.id);
      return;
    }
    if (modifiers?.toggle) {
      const currentIds =
        selected?.kind === "group" &&
        !contentSelectionIds.includes(selected.id)
          ? [selected.id]
          : contentSelectionIds.length > 1
          ? contentSelectionIds
          : selectedId
            ? [selectedId]
            : [];
      const nextIds = toggleLayerSelection(currentIds, layer.id);
      treeSelectionAnchor.current = layer.id;
      setLayerSelection(nextIds, nextIds.includes(layer.id) ? layer.id : null);
      return;
    }
    treeSelectionAnchor.current = layer.id;
    setSelectedArtboardId(layer.artboardId ?? null);
    setSelectedId(layer.id);
    setContentSelectionIds(
      layer.kind === "group" ? descendantImages(layer.id) : [],
    );
    setDoc(
      (current) => ({
        ...current,
        layers: current.layers.map((item) =>
          item.boxSelected ? { ...item, boxSelected: false } : item,
        ),
      }),
      false,
    );
  };
  const syncLiveLayer = (id: string, node: Konva.Image) => {
    const label = liveLabels.current.get(id);
    if (!label) return;
    label.position({
      x: node.x() + node.width() / 2 - labelTextWidth(label) / 2,
      y: node.y() + node.height() + 14 / view.z,
    });
    label.getLayer()?.batchDraw();
  };
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const artboard = doc.artboards.find(item => item.id === importedArtboardToFocus.current);
    // Selecting the imported layer opens the inspector before ResizeObserver updates size.
    const viewport = { width: host.current?.clientWidth ?? size.width, height: host.current?.clientHeight ?? size.height };
    if (!artboard || viewport.width <= 0 || viewport.height <= 0) return;
    importedArtboardToFocus.current = null;
    setView(fitArtboardView(artboard, viewport));
  }, [doc.artboards, size]);
  const setDoc = (
    change: DocumentState | ((d: DocumentState) => DocumentState),
    recordHistory = true,
  ) => dispatchEditor({ type: "document", sceneId: scene.id, pageId: page.id, change, recordHistory });
  const removedSplitCopies = useRef(new Set<string>());
  useEffect(() => {
    const pageKey = `${scene.id}:${page.id}`;
    if (removedSplitCopies.current.has(pageKey)) return;
    const copyIds = new Set(doc.layers.filter(layer => layer.kind === "image" && layer.locked && layer.parentId === null && layer.name.endsWith(" · 原图副本")).map(layer => layer.id));
    if (!copyIds.size) return;
    removedSplitCopies.current.add(pageKey);
    setDoc(current => ({ ...current, layers: current.layers.filter(layer => !copyIds.has(layer.id)) }));
  }, [scene.id, page.id, doc.layers]);
  useEffect(() => {
    if (!doc.layers.some((layer) => layer.kind === "group" && !layer.boundsMode))
      return;
    setDoc(
      (current) => {
        let changed = false;
        const collectImages = (parentId: string): LayerNode[] =>
          current.layers
            .filter((layer) => layer.parentId === parentId)
            .flatMap((layer) =>
              layer.kind === "image"
                ? [layer]
                : layer.kind === "group"
                  ? collectImages(layer.id)
                  : [],
            );
        const layers = current.layers.map((layer) => {
          if (layer.kind !== "group" || layer.boundsMode) return layer;
          const children = collectImages(layer.id);
          changed = true;
          if (!children.length) return { ...layer, boundsMode: "manual" as const };
          const x = Math.min(...children.map((child) => child.x)),
            y = Math.min(...children.map((child) => child.y)),
            right = Math.max(...children.map((child) => child.x + child.width)),
            bottom = Math.max(...children.map((child) => child.y + child.height));
          return {
            ...layer,
            x,
            y,
            width: Math.max(1, right - x),
            height: Math.max(1, bottom - y),
            boundsMode: "manual" as const,
          };
        });
        return changed ? { ...current, layers } : current;
      },
      false,
    );
  }, [doc.layers]);
  const patch = (layerId: string, value: Partial<LayerNode>) =>
    setDoc((d) => {
      const target = d.layers.find((layer) => layer.id === layerId);
      const isPureMove = Object.keys(value).every(
        (key) => key === "x" || key === "y",
      );
      // A marquee selection behaves like Photoshop's multi-object selection: dragging any
      // selected image applies the same delta to every selected image.
      if (
        target?.boxSelected &&
        isPureMove &&
        typeof value.x === "number" &&
        typeof value.y === "number"
      ) {
        const dx = Math.round(value.x - target.x),
          dy = Math.round(value.y - target.y);
        return {
          ...d,
          layers: d.layers.map((layer) =>
            !layer.boxSelected
              ? layer
              : layer.id === layerId
                ? { ...layer, ...value }
                : { ...layer, x: layer.x + dx, y: layer.y + dy },
          ),
        };
      }
      return {
        ...d,
        layers: d.layers.map((layer) =>
          layer.id === layerId ? fitTextLayer({ ...layer, ...value }) : layer,
        ),
      };
    });
  const dropLayer = (layerId: string, x: number, y: number) => {
    const target = doc.layers.find((layer) => layer.id === layerId);
    if (!target) return;
    const moving = target.boxSelected
      ? doc.layers.filter((layer) => layer.boxSelected)
      : [target];
    const dx = x - target.x,
      dy = y - target.y;
    const left = Math.min(...moving.map((layer) => layer.x + dx));
    const top = Math.min(...moving.map((layer) => layer.y + dy));
    const right = Math.max(
      ...moving.map((layer) => layer.x + dx + layer.width),
    );
    const bottom = Math.max(
      ...moving.map((layer) => layer.y + dy + layer.height),
    );
    const destination = artboardContainingPoint(
      doc,
      (left + right) / 2,
      (top + bottom) / 2,
    );
    const movingIds = new Set(moving.map((layer) => layer.id));
    setDoc((current) => ({
      ...current,
      layers: current.layers.map((layer) =>
        movingIds.has(layer.id)
          ? {
              ...layer,
              x: layer.x + dx,
              y: layer.y + dy,
              artboardId: destination?.id,
              parentId:
                destination?.id === layer.artboardId ? layer.parentId : null,
            }
          : layer,
      ),
    }));
    if (destination) {
      setSelectedArtboardId(destination.id);
      if (destination.id !== target.artboardId)
        setNotice(`已将 ${moving.length} 个图层移入画板「${destination.name}」。`);
    } else {
      setSelectedArtboardId(null);
      if (target.artboardId)
        setNotice(`已将 ${moving.length} 个图层移到画板外。`);
    }
  };
  const selectArtboard = (artboardId: string) => {
    setSelectedArtboardId(artboardId);
    setSelectedId(null);
    setContentSelectionIds([]);
    setDoc(
      (current) => ({
        ...current,
        layers: current.layers.map((layer) =>
          layer.boxSelected ? { ...layer, boxSelected: false } : layer,
        ),
      }),
      false,
    );
  };
  const moveArtboard = (artboardId: string, dx: number, dy: number) => {
    const roundedX = Math.round(dx),
      roundedY = Math.round(dy);
    if (!roundedX && !roundedY) return;
    setDoc((current) =>
      translateArtboard(current, artboardId, roundedX, roundedY),
    );
  };
  const setArtboardBounds = (artboardId: string, bounds: Bounds) =>
    setDoc((current) => resizeArtboard(current, artboardId, bounds));
  const assignLayerToArtboard = (layerId: string, artboardId?: string) => {
    const source = doc.layers.find((layer) => layer.id === layerId);
    if (!source) return;
    setDoc((current) =>
      assignLayerDocumentToArtboard(current, layerId, artboardId),
    );
    setSelectedId(layerId);
    setSelectedArtboardId(artboardId ?? null);
    const destination = doc.artboards.find((item) => item.id === artboardId);
    setNotice(
      destination
        ? `已将图层「${source.name}」移入画板「${destination.name}」。`
        : `已将图层「${source.name}」移到画板外。`,
    );
  };
  const restoreHistory = (direction: "undo" | "redo") => {
    const stack = editor.histories[`${scene.id}:${page.id}`];
    if (!stack?.[direction].length) return setNotice(direction === "undo" ? "没有可撤销的操作。" : "没有可重做的操作。");
    dispatchEditor({ type: "history", sceneId: scene.id, pageId: page.id, direction });
    setContentSelectionIds([]);
    setSelectedId(null);
    setSelectedArtboardId(null);
    setNotice(direction === "undo" ? "已撤销。" : "已重做。");
  };
  const selectedLayerBatch = (draggedId: string) =>
    contentSelectionIds.length > 1 && contentSelectionIds.includes(draggedId)
      ? contentSelectionIds
      : [draggedId];
  const reorderLayers = (
    draggedId: string,
    targetId: string,
    position: InsertPosition,
  ) => {
    const movingIds = selectedLayerBatch(draggedId);
    setDoc((current) =>
      reorderLayerBatch(current, movingIds, targetId, position),
    );
    setNotice(`已同步移动 ${movingIds.length} 个图层的层级位置。`);
  };
  const assignLayerBatch = (draggedId: string, artboardId?: string) => {
    const movingIds = selectedLayerBatch(draggedId);
    setDoc((current) =>
      assignLayerBatchToArtboard(current, movingIds, artboardId),
    );
    setSelectedArtboardId(artboardId ?? null);
    setNotice(
      artboardId
        ? `已将 ${movingIds.length} 个图层移入画板。`
        : `已将 ${movingIds.length} 个图层移到画板外。`,
    );
  };
  const choose = (s: string, p: string) => {
    setSceneId(s);
    setPageId(p);
    setContentSelectionIds([]);
    treeSelectionAnchor.current = null;
    setSelectedId(null);
    setSelectedArtboardId(null);
    setView({ x: 80, y: 80, z: 0.5 });
  };
  const addPage = (s: string) => {
    const target = scenes.find((x) => x.id === s)!;
    const p = newPage(`Page ${target.pages.length + 1}`);
    setScenes((old) =>
      old.map((x) => (x.id === s ? { ...x, pages: [...x.pages, p] } : x)),
    );
    choose(s, p.id);
  };
  const rename = (s: string, p: string) => {
    const old = scenes.find((x) => x.id === s)?.pages.find((x) => x.id === p);
    const name = window.prompt("Page 名称", old?.name);
    if (name?.trim())
      setScenes((all) =>
        all.map((x) =>
          x.id !== s
            ? x
            : {
                ...x,
                pages: x.pages.map((y) =>
                  y.id === p ? { ...y, name: name.trim() } : y,
                ),
              },
        ),
      );
  };
  const copy = (s: string, p: string) => {
    const source = scenes
      .find((x) => x.id === s)
      ?.pages.find((x) => x.id === p);
    if (!source) return;
    const next = {
      id: uid(),
      name: `${source.name} 副本`,
      document: structuredClone(source.document),
    };
    setScenes((all) =>
      all.map((x) => (x.id === s ? { ...x, pages: [...x.pages, next] } : x)),
    );
    choose(s, next.id);
  };
  const drop = (s: string, p: string) => {
    const parent = scenes.find((x) => x.id === s)!;
    if (parent.pages.length < 2)
      return setNotice("每个场景至少保留一个 Page。");
    const pages = parent.pages.filter((x) => x.id !== p);
    setScenes((all) => all.map((x) => (x.id !== s ? x : { ...x, pages })));
    if (pageId === p) choose(s, pages[0].id);
  };
  const importPsdFile = async (input: File) => {
    try {
      setNotice("正在本地读取 PSD 图层…");
      const imported = await importPsd(input);
      const imageLayer = imported.layers.find(
        (layer) => layer.kind === "image",
      );
      const artboardId = uid();
      importedArtboardToFocus.current = artboardId;
      setDoc((current) => {
        const origin = nextArtboardOrigin(current.artboards);
        const baseZ =
          Math.max(-1, ...current.layers.map((layer) => layer.zIndex)) + 1;
        const artboard = {
          id: artboardId,
          name: input.name.replace(/\.psd$/i, ""),
          ...origin,
          width: imported.canvas.width,
          height: imported.canvas.height,
        };
        const appended = imported.layers.map((layer, index) => ({
          ...layer,
          artboardId,
          x: layer.x + origin.x,
          y: layer.y + origin.y,
          zIndex: baseZ + index,
          boxSelected: false,
        }));
        const artboards = [...current.artboards, artboard];
        return {
          ...current,
          canvas: documentBounds(artboards),
          artboards,
          layers: [...current.layers, ...appended],
        };
      });
      setContentSelectionIds([]);
      setSelectedArtboardId(artboardId);
      setSelectedId(imageLayer?.id || null);
      setNotice(
        `已追加 PSD：${imported.layers.filter((layer) => layer.kind === "image").length} 个图像图层，已有图层保持不变。`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? `PSD 导入失败：${error.message}`
          : "PSD 导入失败。",
      );
    }
  };
  const upload = (input?: File) => {
    if (!input) return;
    if (input.name.toLowerCase().endsWith(".psd")) {
      void importPsdFile(input);
      return;
    }
    if (!input.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp|svg|avif|ico)$/i.test(input.name)) {
      setNotice(`无法导入「${input.name}」：请选择图片或 PSD 文件。`);
      return;
    }
    setNotice(`正在读取「${input.name}」…`);
    const reader = new FileReader();
    reader.onerror = () => setNotice(`无法读取「${input.name}」：请检查文件是否可访问。`);
    reader.onabort = () => setNotice(`已取消读取「${input.name}」。`);
    reader.onload = () => {
      const source = String(reader.result),
        image = new Image();
      image.onload = () => {
        const id = uid(),
          artboardId = uid(),
          name = input.name.replace(/\.[^.]+$/, "");
        importedArtboardToFocus.current = artboardId;
        setDoc((d) => {
          const origin = nextArtboardOrigin(d.artboards);
          const artboard = {
            id: artboardId,
            name,
            ...origin,
            width: image.naturalWidth,
            height: image.naturalHeight,
          };
          const layer: LayerNode = {
            id,
            name,
            kind: "image",
            parentId: null,
            artboardId,
            x: origin.x,
            y: origin.y,
            width: image.naturalWidth,
            height: image.naturalHeight,
            assetWidth: image.naturalWidth,
            assetHeight: image.naturalHeight,
            zIndex: Math.max(-1, ...d.layers.map((layer) => layer.zIndex)) + 1,
            visible: true,
            locked: false,
            opacity: 1,
            source,
          };
          const artboards = [...d.artboards, artboard];
          return {
            ...d,
            canvas: documentBounds(artboards),
            artboards,
            layers: [...d.layers, layer],
          };
        });
        setContentSelectionIds([]);
        setSelectedArtboardId(artboardId);
        setSelectedId(id);
        setNotice(`已创建画板「${name}」，原图已作为可拖动的画板图层。`);
      };
      image.onerror = () => setNotice(`无法解码「${input.name}」：文件可能损坏或格式不受浏览器支持，请转换为 PNG、JPG 或 WebP 后重试。`);
      image.src = source;
    };
    reader.readAsDataURL(input);
  };
  const addSelection = () => {
    if (!activeArtboard) return setNotice("请先导入图片创建画板。");
    const width = Math.min(260, activeArtboard.width * 0.2),
      height = Math.min(160, activeArtboard.height * 0.15);
    const layer: LayerNode = {
      id: uid(),
      name: "待提取区域",
      kind: "selection",
      parentId: null,
      artboardId: activeArtboard.id,
      x: Math.round(activeArtboard.x + (activeArtboard.width - width) / 2),
      y: Math.round(activeArtboard.y + (activeArtboard.height - height) / 2),
      width: Math.round(width),
      height: Math.round(height),
      zIndex: Math.max(0, ...doc.layers.map((l) => l.zIndex)) + 1,
      visible: true,
      locked: false,
    };
    setDoc((d) => ({ ...d, layers: [...d.layers, layer] }));
    setSelectedId(layer.id);
  };
  const extract = () => {
    if (selected?.kind !== "selection") return setNotice("请选择待提取区域。");
    const sourceLayer = doc.layers
      .filter(l => l.artboardId === selected.artboardId && l.kind === "image" && l.source)
      .sort((a, b) => a.zIndex - b.zIndex)[0];
    if (!sourceLayer?.source) return setNotice("选区所在画板没有可提取的源图片。");
    const image = new Image();
    image.onerror = () => setNotice("无法读取选区源图片。");
    image.onload = () => {
      const canvas = extractSelectionCanvas(image, sourceLayer, selected);
      const layer: LayerNode = {
        ...selected,
        id: uid(),
        name: `图层_${doc.layers.length}`,
        kind: "image",
        locked: false,
        opacity: 1,
        assetWidth: canvas.width,
        assetHeight: canvas.height,
        source: canvas.toDataURL("image/png"),
      };
      setDoc((d) => ({
        ...d,
        layers: d.layers.map((l) => (l.id === selected.id ? layer : l)),
      }));
      setSelectedId(layer.id);
    };
    image.src = sourceLayer.source;
  };
  const groupSelectedLayers = () => {
    const ids = contentSelectionIds.filter((id) =>
      doc.layers.some((layer) => layer.id === id && layer.kind === "image"),
    );
    if (!ids.length) return setNotice("请先在画布中框选至少一个图片图层。");
    if (new Set(doc.layers.filter(layer => ids.includes(layer.id)).map(layer => layer.artboardId)).size !== 1) return setNotice("只能编组同一画板内的图层。");
    const groupId = uid();
    setDoc((current) => {
      const children = current.layers.filter((layer) => ids.includes(layer.id));
      const artboardIds = [
        ...new Set(children.map((layer) => layer.artboardId)),
      ];
      if (artboardIds.length !== 1) {
        return current;
      }
      const x = Math.min(...children.map((layer) => layer.x)),
        y = Math.min(...children.map((layer) => layer.y)),
        right = Math.max(...children.map((layer) => layer.x + layer.width)),
        bottom = Math.max(...children.map((layer) => layer.y + layer.height));
      const group: LayerNode = {
        id: groupId,
        name: `Group${current.layers.filter((layer) => layer.kind === "group").length + 1}`,
        kind: "group",
        parentId: null,
        artboardId: artboardIds[0],
        x,
        y,
        width: Math.max(1, right - x),
        height: Math.max(1, bottom - y),
        zIndex: Math.min(...children.map((layer) => layer.zIndex)),
        visible: true,
        locked: false,
        boundsMode: "manual",
      };
      return {
        ...current,
        layers: [
          ...current.layers.map((layer) =>
            ids.includes(layer.id)
              ? { ...layer, parentId: groupId, boxSelected: false }
              : layer,
          ),
          group,
        ],
      };
    });
    setContentSelectionIds(ids);
    setSelectedId(groupId);
    setNotice(`已创建图层组，包含 ${ids.length} 个图片图层。`);
  };
  const moveGroup = (groupId: string, dx: number, dy: number) => {
    const roundedX = Math.round(dx),
      roundedY = Math.round(dy);
    if (!roundedX && !roundedY) return;
    setDoc((current) => {
      const collect = (parentId: string): string[] =>
        current.layers
          .filter((layer) => layer.parentId === parentId)
          .flatMap((layer) => [layer.id, ...collect(layer.id)]);
      const movingIds = new Set([groupId, ...collect(groupId)]);
      return {
        ...current,
        layers: current.layers.map((layer) =>
          movingIds.has(layer.id)
            ? { ...layer, x: layer.x + roundedX, y: layer.y + roundedY }
            : layer,
        ),
      };
    });
  };
  const moveMultiSelection = (dx: number, dy: number) => {
    if (!dx && !dy) return;
    setDoc((current) => ({
      ...current,
      layers: current.layers.map((layer) =>
        contentSelectionIds.includes(layer.id)
          ? { ...layer, x: layer.x + dx, y: layer.y + dy }
          : layer,
      ),
    }));
  };
  const scaleMultiSelection = (
    bounds: Bounds,
    originX: number,
    originY: number,
    sx: number,
    sy: number,
  ) => {
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0)
      return;
    setDoc((current) => ({
      ...current,
      layers: current.layers.map((layer) =>
        !contentSelectionIds.includes(layer.id)
          ? layer
          : {
              ...layer,
              x: Math.round(originX + (layer.x - bounds.x) * sx),
              y: Math.round(originY + (layer.y - bounds.y) * sy),
              width: Math.max(2, Math.round(layer.width * sx)),
              height: Math.max(2, Math.round(layer.height * sy)),
            },
      ),
    }));
  };
  const wheel = (event: Konva.KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault();
    const point = event.target.getStage()!.getPointerPosition()!,
      z = Math.max(
        0.08,
        Math.min(4, view.z * (event.evt.deltaY > 0 ? 0.9 : 1.1)),
      ),
      world = {
        x: (point.x - view.x) / view.z,
        y: (point.y - view.y) / view.z,
      };
    setView({ z, x: point.x - world.x * z, y: point.y - world.y * z });
  };
  const field = (label: string, key: keyof LayerNode, value: number, inline = false) => (
    <label>
      {inline ? <span className="field-inline-label">{label}</span> : label}
      <input
        type="number"
        aria-label={label}
        value={value}
        onChange={(e) => {
          if (!selected) return;
          const input = +e.target.value;
          if (selected.kind === "group" && (key === "x" || key === "y")) {
            const absolute = input + (key === "x" ? activeArtboard?.x ?? 0 : activeArtboard?.y ?? 0);
            moveGroup(
              selected.id,
              key === "x" ? absolute - selected.x : 0,
              key === "y" ? absolute - selected.y : 0,
            );
            return;
          }
          patch(selected.id, {
            [key]:
              key === "x"
                ? input + (activeArtboard?.x ?? 0)
                : key === "y"
                  ? input + (activeArtboard?.y ?? 0)
                  : input,
          });
        }}
      />
    </label>
  );
  const resize = (axis: "width" | "height", value: number) => {
    if (!selected) return;
    const next = Math.max(2, value);
    if (!ratioLocked) return patch(selected.id, { [axis]: next });
    const ratio = selected.width / selected.height;
    patch(
      selected.id,
      axis === "width"
        ? { width: next, height: Math.max(2, Math.round(next / ratio)) }
        : { height: next, width: Math.max(2, Math.round(next * ratio)) },
    );
  };
  const targetIds = () =>
    contentSelectionIds.length > 1
      ? contentSelectionIds
      : selected
        ? [selected.id]
        : [];
  const deleteSelectedLayers = () => {
    const ids = contentSelectionIds.length
      ? contentSelectionIds
      : selected
        ? [selected.id]
        : [];
    if (!ids.length) return;
    const existingIds = ids.filter((id) => doc.layers.some((layer) => layer.id === id));
    if (!existingIds.length) return;
    setDoc((current) => removeLayerBatch(current, existingIds));
    setSelectedId(null);
    setContentSelectionIds([]);
    setNotice(`已删除 ${existingIds.length} 个选中图层。`);
  };
  const deleteSelectedArtboard = () => {
    if (!selectedArtboardId || selectedId || contentSelectionIds.length) return;
    const artboard = doc.artboards.find(
      (item) => item.id === selectedArtboardId,
    );
    if (!artboard) return;
    setDoc((current) => removeArtboard(current, artboard.id));
    setSelectedArtboardId(null);
    setNotice(`已删除画板「${artboard.name}」及其所属图层。`);
  };
  const alignLayers = (
    mode:
      | "left"
      | "centerX"
      | "right"
      | "top"
      | "centerY"
      | "bottom"
      | "spaceX"
      | "spaceY",
  ) => {
    const ids = targetIds();
    if (!ids.length) return;
    const alignmentTargets = doc.layers.filter(layer => ids.includes(layer.id) && layer.kind === "image");
    if (new Set(alignmentTargets.map(layer => layer.artboardId)).size !== 1) return setNotice("只能对齐或分布同一画板内的图层。");
    if ((mode === "spaceX" || mode === "spaceY") && alignmentTargets.length < 3) return setNotice("等距分布至少需要选择 3 个图片图层。");
    setDoc((current) => {
      const targets = current.layers.filter(
        (layer) => ids.includes(layer.id) && layer.kind === "image",
      );
      if (!targets.length) return current;
      const artboardIds = [
        ...new Set(targets.map((layer) => layer.artboardId)),
      ];
      if (artboardIds.length !== 1) {
        return current;
      }
      const artboard = current.artboards.find(
        (item) => item.id === artboardIds[0],
      );
      if (!artboard) return current;
      if ((mode === "spaceX" || mode === "spaceY") && targets.length < 3) {
        return current;
      }
      const next = new Map<string, Partial<LayerNode>>();
      if (mode === "spaceX") {
        const sorted = [...targets].sort((a, b) => a.x - b.x),
          left = sorted[0].x,
          right = sorted.at(-1)!.x + sorted.at(-1)!.width,
          total = sorted.reduce((sum, layer) => sum + layer.width, 0),
          gap = (right - left - total) / (sorted.length - 1);
        let x = left;
        sorted.forEach((layer) => {
          next.set(layer.id, { x: Math.round(x) });
          x += layer.width + gap;
        });
      } else if (mode === "spaceY") {
        const sorted = [...targets].sort((a, b) => a.y - b.y),
          top = sorted[0].y,
          bottom = sorted.at(-1)!.y + sorted.at(-1)!.height,
          total = sorted.reduce((sum, layer) => sum + layer.height, 0),
          gap = (bottom - top - total) / (sorted.length - 1);
        let y = top;
        sorted.forEach((layer) => {
          next.set(layer.id, { y: Math.round(y) });
          y += layer.height + gap;
        });
      } else if (targets.length === 1)
        targets.forEach((layer) =>
          next.set(
            layer.id,
            mode === "left"
              ? { x: artboard.x }
              : mode === "centerX"
                ? {
                    x: Math.round(
                      artboard.x + (artboard.width - layer.width) / 2,
                    ),
                  }
                : mode === "right"
                  ? { x: artboard.x + artboard.width - layer.width }
                  : mode === "top"
                    ? { y: artboard.y }
                    : mode === "centerY"
                      ? {
                          y: Math.round(
                            artboard.y + (artboard.height - layer.height) / 2,
                          ),
                        }
                      : { y: artboard.y + artboard.height - layer.height },
          ),
        );
      else {
        const bounds = {
          left: Math.min(...targets.map((layer) => layer.x)),
          top: Math.min(...targets.map((layer) => layer.y)),
          right: Math.max(...targets.map((layer) => layer.x + layer.width)),
          bottom: Math.max(...targets.map((layer) => layer.y + layer.height)),
        };
        targets.forEach((layer) =>
          next.set(
            layer.id,
            mode === "left"
              ? { x: bounds.left }
              : mode === "centerX"
                ? {
                    x: Math.round(
                      (bounds.left + bounds.right - layer.width) / 2,
                    ),
                  }
                : mode === "right"
                  ? { x: bounds.right - layer.width }
                  : mode === "top"
                    ? { y: bounds.top }
                    : mode === "centerY"
                      ? {
                          y: Math.round(
                            (bounds.top + bounds.bottom - layer.height) / 2,
                          ),
                        }
                      : { y: bounds.bottom - layer.height },
          ),
        );
      }
      return {
        ...current,
        layers: current.layers.map((layer) =>
          next.has(layer.id) ? { ...layer, ...next.get(layer.id) } : layer,
        ),
      };
    });
  };
  const transformSelectedBitmap = (mode: "flipX" | "flipY" | "rotate90") => {
    if (!selected?.source || selected.kind !== "image") return;
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas"),
        rotate = mode === "rotate90";
      canvas.width = rotate ? image.naturalHeight : image.naturalWidth;
      canvas.height = rotate ? image.naturalWidth : image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.save();
      if (mode === "flipX") {
        context.translate(canvas.width, 0);
        context.scale(-1, 1);
      } else if (mode === "flipY") {
        context.translate(0, canvas.height);
        context.scale(1, -1);
      } else {
        context.translate(canvas.width, 0);
        context.rotate(Math.PI / 2);
      }
      context.drawImage(image, 0, 0);
      context.restore();
      if (rotate)
        patch(selected.id, {
          source: canvas.toDataURL("image/png"),
          x: Math.round(selected.x + (selected.width - selected.height) / 2),
          y: Math.round(selected.y + (selected.height - selected.width) / 2),
          width: selected.height,
          height: selected.width,
          assetWidth: canvas.width,
          assetHeight: canvas.height,
        });
      else
        patch(selected.id, {
          source: canvas.toDataURL("image/png"),
          assetWidth: canvas.width,
          assetHeight: canvas.height,
        });
    };
    image.src = selected.source;
  };
  const appendSplitComparison = (
    sourceArtboard: Artboard,
    sourceLayer: LayerNode,
    resultLayers: LayerNode[],
    imageWidth: number,
    imageHeight: number,
  ) => {
    const comparisonArtboard: Artboard = {
      id: uid(),
      name: `${sourceArtboard.name} · 拆分对比`,
      ...nextArtboardOrigin(doc.artboards),
      width: sourceArtboard.width,
      height: sourceArtboard.height,
    };
    setDoc((current) => addSplitComparisonArtboard(
      current,
      sourceArtboard,
      sourceLayer,
      resultLayers,
      imageWidth,
      imageHeight,
      { artboard: comparisonArtboard },
    ).document);
    setSelectedArtboardId(comparisonArtboard.id);
    setSelectedId(null);
    setContentSelectionIds([]);
    setView(comparisonViewport(sourceArtboard, comparisonArtboard, size));
    return comparisonArtboard;
  };
  const splitWithSeedream = async (
    targetLayer = doc.layers.find((layer) => layer.kind === "image"),
    boxes?: SmartSplitBox[],
    propagateError = false,
    textLayers: LayerNode[] = [],
    textBoxes: SmartSplitBox[] = [],
  ) => {
    const source = targetLayer?.source;
    if (!source) return setNotice("请先导入一张图片，再使用 AI 拆分。");
    if (splitting) return;
    setSplitting(true);
    setNotice("Seedream 5.0 Pro 正在拆分图层…");
    try {
      const imageWidth =
          targetLayer?.assetWidth || targetLayer?.width || doc.canvas.width,
        imageHeight =
          targetLayer?.assetHeight || targetLayer?.height || doc.canvas.height;
      const splitBoxes = selectSplittableBoxes(boxes || []);
      if (boxes?.length && !splitBoxes.length) {
        setNotice("程序文字已保留，当前没有需要拆分的 UI 元素。");
        return;
      }
      const prompt = splitBoxes.length
        ? `请进行图层拆分。仅把下列框选区域分别生成为独立透明图层；未标注区域保留为底图。坐标相对这张图片，使用 0-999 归一化坐标。保持原图像素尺寸、元素位置和视觉内容，不要新增或改写标注。${splitBoxes
            .map((box, index) => {
              const [x1, y1, x2, y2] = pixelToNormalizedBBox(
                box.bbox,
                imageWidth,
                imageHeight,
              );
              return `区域 ${index + 1}（UI 元素「${box.name || `区域 ${index + 1}`}」）：<bbox>${x1} ${y1} ${x2} ${y2}</bbox>`;
            })
            .join(" ")}`
        : undefined;
      const layers = await seedreamLayerSplit(
        source,
        imageWidth,
        imageHeight,
        prompt,
        splitBoxes.length ? splitBoxes : undefined,
      );
      const sourceLayer = targetLayer;
      const artboard = artboardForLayer(doc, sourceLayer);
      if (!artboard) throw new Error("源图片没有所属画板，无法放置拆分结果。");
      const comparison = appendSplitComparison(
        artboard,
        sourceLayer,
        [...layers, ...textLayers],
        imageWidth,
        imageHeight,
      );
      setNotice(`已在右侧新建画板「${comparison.name}」，${layers.length} 个 Seedream 返回图层已放入其中；原图保持不变。`);
    } catch (error) {
      if (propagateError) throw error;
      setNotice(
        error instanceof Error ? error.message : "Seedream 图层拆分失败。",
      );
    } finally {
      setSplitting(false);
    }
  };
  const splitWithLocalComfy = async (
    targetLayer: LayerNode,
    boxes: SmartSplitBox[],
    config: LocalComfyConfig,
    propagateError = false,
    textLayers: LayerNode[] = [],
    textBoxes: SmartSplitBox[] = [],
  ) => {
    const source = targetLayer.source;
    if (!source) return setNotice("请先导入一张图片，再使用本地拆分。");
    if (splitting) return;
    const splitBoxes = selectSplittableBoxes(boxes);
    if (!splitBoxes.length) {
      const message = "本地拆分需要至少一个可拆分的 UI 框选区域。";
      if (propagateError) throw new Error(message);
      return setNotice(message);
    }
    setSplitting(true);
    const includeBackground = config.splitBackground !== false;
    setNotice(`ComfyUI 将处理 ${splitBoxes.length} 个框选区域${includeBackground ? '，并单独拆分背景' : ''}…`);
    try {
      const imageWidth =
          targetLayer.assetWidth || targetLayer.width || doc.canvas.width,
        imageHeight =
          targetLayer.assetHeight || targetLayer.height || doc.canvas.height;
      const layers = await localComfyLayerSplit(source, splitBoxes, config, boxes);
      const artboard = artboardForLayer(doc, targetLayer);
      if (!artboard) throw new Error("源图片没有所属画板，无法放置本地拆分结果。");
      const comparison = appendSplitComparison(
        artboard,
        targetLayer,
        [...layers, ...textLayers],
        imageWidth,
        imageHeight,
      );
      setNotice(`已在右侧新建画板「${comparison.name}」，${layers.length - (includeBackground ? 1 : 0)} 个框选图层${includeBackground ? '和 1 个背景图层' : ''}已放入其中；原图保持不变。`);
    } catch (error) {
      if (propagateError) throw error;
      setNotice(error instanceof Error ? error.message : "ComfyUI 本地拆分失败。");
    } finally {
      setSplitting(false);
    }
  };
  const splitWithRunningHub = async (
    targetLayer: LayerNode,
    boxes: SmartSplitBox[],
    config: RunningHubConfig,
    propagateError = false,
    textLayers: LayerNode[] = [],
    textBoxes: SmartSplitBox[] = [],
  ) => {
    const source = targetLayer.source;
    if (!source) return setNotice("请先导入一张图片，再使用 RunningHub 拆分。");
    if (splitting) return;
    const splitBoxes = selectSplittableBoxes(boxes);
    if (!splitBoxes.length) {
      const message = "RunningHub 拆分需要至少一个可拆分的 UI 框选区域。";
      if (propagateError) throw new Error(message);
      return setNotice(message);
    }
    setSplitting(true);
    const includeBackground = config.splitBackground !== false;
    setNotice(`RunningHub 将处理 ${splitBoxes.length} 个框选区域${includeBackground ? '，并单独拆分背景' : ''}…`);
    try {
      const imageWidth = targetLayer.assetWidth || targetLayer.width || doc.canvas.width;
      const imageHeight = targetLayer.assetHeight || targetLayer.height || doc.canvas.height;
      const layers = await runningHubLayerSplit(source, splitBoxes, config, boxes);
      const artboard = artboardForLayer(doc, targetLayer);
      if (!artboard) throw new Error("源图片没有所属画板，无法放置 RunningHub 拆分结果。");
      const comparison = appendSplitComparison(
        artboard,
        targetLayer,
        [...layers, ...textLayers],
        imageWidth,
        imageHeight,
      );
      const imageCount = layers.filter((layer) => layer.kind === "image").length;
      const groupCount = layers.filter((layer) => layer.kind === "group").length;
      setNotice(`已在右侧新建画板「${comparison.name}」，${imageCount - (includeBackground ? 1 : 0)} 个框选图层${includeBackground ? '和 1 个背景图层' : ''}已放入其中${groupCount ? `，包含 ${groupCount} 个重叠框组` : ""}；原图保持不变。`);
    } catch (error) {
      if (propagateError) throw error;
      setNotice(error instanceof Error ? error.message : "RunningHub 工作流拆分失败。");
    } finally {
      setSplitting(false);
    }
  };
  const smartSplitPortal =
    smartSplitOpen && selected?.kind === "image"
      ? createPortal(
          <SmartSplitWorkspace
            image={selected}
            onCancel={() => setSmartSplitOpen(false)}
            onStart={async (
              boxes: SmartSplitBox[],
              mode: SplitMode,
              config?: LocalComfyConfig | RunningHubConfig,
            ) => {
              const splitBoxes = selectSplittableBoxes(boxes);
              const textLayers = textLayersFromBoxes(boxes);
              if (boxes.length && !splitBoxes.length) {
                if (!textLayers.length) throw new Error("没有需要拆分的 UI 或可应用的程序文字。");
                if (!selected.source || !selected.artboardId) throw new Error("请选择画板内的源图片。");
                const sourceLayer = selected;
                const placed = placeTextLayers(textLayers, sourceLayer, sourceLayer.assetWidth || sourceLayer.width, sourceLayer.assetHeight || sourceLayer.height);
                setDoc(current => applyTextOverlay(current, sourceLayer.id, placed));
                setSelectedId(placed[0].id);
                setSelectedArtboardId(sourceLayer.artboardId ?? null);
                setContentSelectionIds([]);
                setNotice(`已在原位创建 ${placed.length} 个可编辑文字图层，原图和其他图层保持不变，文字随内容自动扩展。`);
              } else if (mode === "local") {
                if (!config) throw new Error("缺少 ComfyUI 本地拆分配置。");
                await splitWithLocalComfy(selected, boxes, config as LocalComfyConfig, true, textLayers, boxes);
              } else if (mode === "runninghub") {
                if (!config) throw new Error("缺少 RunningHub 工作流配置。");
                await splitWithRunningHub(selected, boxes, config as RunningHubConfig, true, textLayers, boxes);
              } else {
                await splitWithSeedream(selected, splitBoxes.length ? splitBoxes : undefined, true, textLayers, boxes);
              }
              setSmartSplitOpen(false);
            }}
          />,
          document.body,
        )
      : null;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "g")
        return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]'))
        return;
      event.preventDefault();
      groupSelectedLayers();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contentSelectionIds, doc.layers]);
  useEffect(() => {
    const onDeleteKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]'))
        return;
      if (
        smartSplitOpen ||
        (!selectedId && !contentSelectionIds.length && !selectedArtboardId)
      )
        return;
      event.preventDefault();
      if (selectedId || contentSelectionIds.length) deleteSelectedLayers();
      else deleteSelectedArtboard();
    };
    window.addEventListener("keydown", onDeleteKey);
    return () => window.removeEventListener("keydown", onDeleteKey);
  }, [
    contentSelectionIds,
    doc.layers,
    selectedArtboardId,
    selectedId,
    smartSplitOpen,
  ]);
  useEffect(() => {
    const onHistoryKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z")
        return;
      if (smartSplitOpen) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]'))
        return;
      event.preventDefault();
      restoreHistory(event.altKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", onHistoryKey);
    return () => window.removeEventListener("keydown", onHistoryKey);
  }, [scene.id, page.id, doc, smartSplitOpen]);
  useEffect(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".tree .layer-row"),
    );
    let pending:
        | { layerId: string; startX: number; startY: number }
        | undefined,
      active = false,
      targetRow: HTMLElement | null = null,
      insertPosition: InsertPosition = "before";
    const clearTarget = () => {
      targetRow?.classList.remove("drop-target", "drop-before", "drop-after");
      targetRow = null;
    };
    const starts = rows.flatMap((row) => {
      const layerId = row.dataset.layerId,
        artboardId = row.dataset.artboardId,
        outsideDrop = row.dataset.outsideDrop === "true";
      row.draggable = false;
      if (layerId) row.title = "拖动以调整层级或更改所属画板";
      else if (artboardId || outsideDrop)
        row.title = artboardId ? "将图层拖入此画板" : "将图层移到画板外";
      if (!layerId) return [];
      const start = (event: MouseEvent) => {
        if (event.button !== 0) return;
        pending = {
          layerId,
          startX: event.clientX,
          startY: event.clientY,
        };
      };
      row.addEventListener("mousedown", start);
      return [{ row, start }];
    });
    const move = (event: MouseEvent) => {
      if (!pending) return;
      if (
        !active &&
        Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) < 5
      )
        return;
      active = true;
      event.preventDefault();
      let candidate = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(
          ".tree .layer-row[data-layer-id],.tree .layer-row[data-artboard-id],.tree .layer-row[data-outside-drop]",
        );
      if (
        candidate?.dataset.layerId &&
        selectedLayerBatch(pending.layerId).includes(candidate.dataset.layerId)
      )
        candidate = null;
      const nextPosition: InsertPosition =
        candidate?.dataset.layerId &&
        event.clientY >
          candidate.getBoundingClientRect().top + candidate.offsetHeight / 2
          ? "after"
          : "before";
      if (candidate === targetRow && nextPosition === insertPosition) return;
      clearTarget();
      targetRow = candidate ?? null;
      insertPosition = nextPosition;
      if (targetRow?.dataset.layerId)
        targetRow.classList.add(
          insertPosition === "before" ? "drop-before" : "drop-after",
        );
      else targetRow?.classList.add("drop-target");
    };
    const finish = (event: MouseEvent) => {
      if (!pending) return;
      if (active) {
        event.preventDefault();
        event.stopPropagation();
        suppressTreeClick.current = true;
        const targetLayerId = targetRow?.dataset.layerId,
          targetArtboardId = targetRow?.dataset.artboardId,
          outsideDrop = targetRow?.dataset.outsideDrop === "true";
        if (targetLayerId && targetLayerId !== pending.layerId)
          reorderLayers(pending.layerId, targetLayerId, insertPosition);
        else if (targetArtboardId || outsideDrop)
          assignLayerBatch(pending.layerId, targetArtboardId);
      }
      pending = undefined;
      active = false;
      clearTarget();
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", finish, true);
    return () => {
      starts.forEach(({ row, start }) =>
        row.removeEventListener("mousedown", start),
      );
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", finish, true);
      clearTarget();
    };
  }, [doc.layers, doc.artboards, contentSelectionIds]);
  useEffect(() => {
    const stage = Konva.stages.find((candidate) =>
      Boolean(host.current && host.current.contains(candidate.container())),
    );
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
    container.addEventListener("mousedown", beginMiddlePan, true);
    container.addEventListener("mouseup", endMiddlePan, true);
    container.addEventListener("auxclick", endMiddlePan, true);
    window.addEventListener("mouseup", endMiddlePan, true);
    // Do not leave the Stage draggable: otherwise it competes with child image drags and causes cursor-relative jumps.
    stage.draggable(false);
    const beginTouchPan = (event: Konva.KonvaEventObject<TouchEvent>) => {
      if (event.target !== stage) return;
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
    stage.on("touchstart.canvas-pan", beginTouchPan);
    stage.on("dragstart.canvas-pan", protectChildDrag);
    stage.on("dragend.canvas-pan", endPan);
    return () => {
      container.removeEventListener("mousedown", beginMiddlePan, true);
      container.removeEventListener("mouseup", endMiddlePan, true);
      container.removeEventListener("auxclick", endMiddlePan, true);
      window.removeEventListener("mouseup", endMiddlePan, true);
      stage.off(".canvas-pan");
      stage.draggable(false);
    };
  }, [doc.layers, size.width, size.height]);
  useEffect(() => {
    const stage = Konva.stages.find((candidate) =>
      Boolean(host.current && host.current.contains(candidate.container())),
    );
    if (!stage) return;
    // Only commit viewport coordinates when the Stage itself was dragged.
    const finish = (event: Konva.KonvaEventObject<DragEvent>) => {
      if (event.target === stage)
        setView((current) => ({
          ...current,
          x: Math.round(stage.x()),
          y: Math.round(stage.y()),
        }));
      stage.draggable(false);
    };
    stage.on("dragend.drag-fix", finish);
    return () => {
      stage.off(".drag-fix");
    };
  }, [doc.layers, selectedId, size.width, size.height, view.x, view.y, view.z]);
  useEffect(() => {
    const stage = Konva.stages.find((candidate) =>
      Boolean(host.current && host.current.contains(candidate.container())),
    );
    if (!stage) return;
    const openDesign = (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (event.target instanceof Konva.Image) setTab("design");
    };
    stage.on("click.inspector-open tap.inspector-open", openDesign);
    return () => {
      stage.off(".inspector-open");
    };
  }, [doc.layers, size.width, size.height]);
  useEffect(() => {
    const stage = Konva.stages.find((candidate) =>
      Boolean(host.current && host.current.contains(candidate.container())),
    );
    if (!stage || !selected || selected.kind !== "image") return;
    stage
      .find("Transformer")
      .forEach((node) => (node as Konva.Transformer).rotateEnabled(false));
    const visibleImages = [...doc.layers]
      .sort((a, b) => a.zIndex - b.zIndex)
      .filter((layer) => layer.kind === "image" && layer.visible);
    const image = stage.find("Image")[
      visibleImages.findIndex((layer) => layer.id === selected.id)
    ] as Konva.Image | undefined;
    if (!image) return;
    let start: { angle: number; rotation: number } | undefined;
    const point = () => {
      const pointer = stage.getPointerPosition()!;
      return {
        x: (pointer.x - stage.x()) / stage.scaleX(),
        y: (pointer.y - stage.y()) / stage.scaleY(),
      };
    };
    const cornerAngle = () => {
      const p = point(),
        corners = [
          [selected.x, selected.y],
          [selected.x + selected.width, selected.y],
          [selected.x, selected.y + selected.height],
          [selected.x + selected.width, selected.y + selected.height],
        ];
      const corner = corners.find(
        ([x, y]) =>
          Math.hypot(p.x - x, p.y - y) <= 26 &&
          (p.x < x - 5 || p.x > x + 5 || p.y < y - 5 || p.y > y + 5),
      );
      if (!corner) return undefined;
      return Math.atan2(
        p.y - (selected.y + selected.height / 2),
        p.x - (selected.x + selected.width / 2),
      );
    };
    const move = (event: Konva.KonvaEventObject<MouseEvent>) => {
      // Transformer anchors already set a direction-specific resize cursor.
      // Keep the custom corner-rotation cursor from overriding it.
      if (event.target.name().includes("_anchor")) return;
      const angle = cornerAngle();
      stage.container().style.cursor =
        angle === undefined && !start ? "default" : "crosshair";
      if (!start) return;
      const p = point(),
        current = Math.atan2(
          p.y - (selected.y + selected.height / 2),
          p.x - (selected.x + selected.width / 2),
        );
      image.rotation(
        start.rotation + ((current - start.angle) * 180) / Math.PI,
      );
      image.getLayer()?.batchDraw();
    };
    const down = (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (event.evt.button !== 0) return;
      const angle = cornerAngle();
      if (angle === undefined) return;
      event.cancelBubble = true;
      start = { angle, rotation: image.rotation() };
      stage.container().style.cursor = "crosshair";
    };
    const up = () => {
      if (start) patch(selected.id, { rotation: Math.round(image.rotation()) });
      start = undefined;
      stage.container().style.cursor = "default";
    };
    stage.on("mousemove.corner-rotate", move);
    stage.on("mousedown.corner-rotate", down);
    stage.on("mouseup.corner-rotate", up);
    return () => {
      stage.off(".corner-rotate");
      stage.container().style.cursor = "default";
    };
  }, [selectedId, doc.layers, size.width, size.height, view.x, view.y, view.z]);
  useEffect(() => {
    const stage = Konva.stages.find((candidate) =>
      Boolean(host.current && host.current.contains(candidate.container())),
    );
    const layer = stage?.getLayers()[0];
    if (!stage || !layer) return;
    let start: { x: number; y: number } | undefined;
    let marquee: Konva.Rect | undefined;
    const point = () => {
      const pointer = stage.getPointerPosition()!;
      return {
        x: (pointer.x - stage.x()) / stage.scaleX(),
        y: (pointer.y - stage.y()) / stage.scaleY(),
      };
    };
    const begin = (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (event.evt.button !== 0 || event.target !== stage) return;
      event.evt.preventDefault();
      stage.stopDrag();
      stage.draggable(false);
      start = point();
      marquee = new Konva.Rect({
        x: start.x,
        y: start.y,
        width: 0,
        height: 0,
        stroke: "#b6f04a",
        strokeWidth: 2,
        dash: [7, 5],
        fill: "rgba(182,240,74,.12)",
        listening: false,
      });
      layer.add(marquee);
      layer.batchDraw();
    };
    const move = () => {
      if (!start || !marquee) return;
      const end = point();
      marquee.setAttrs({
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      });
      layer.batchDraw();
    };
    const finish = () => {
      if (!start || !marquee) return;
      const x = Math.round(marquee.x()),
        y = Math.round(marquee.y()),
        width = Math.round(marquee.width()),
        height = Math.round(marquee.height());
      marquee.destroy();
      layer.batchDraw();
      marquee = undefined;
      start = undefined;
      if (width < 3 || height < 3) {
        setContentSelectionIds([]);
        setSelectedId(null);
        setDoc(
          (current) => ({
            ...current,
            layers: current.layers.map((item) =>
              item.boxSelected ? { ...item, boxSelected: false } : item,
            ),
          }),
          false,
        );
        return;
      }
      const selectedIds = doc.layers
        .filter(
          (item) =>
            item.kind === "image" &&
            item.visible &&
            item.x < x + width &&
            item.x + item.width > x &&
            item.y < y + height &&
            item.y + item.height > y,
        )
        .map((item) => item.id);
      setDoc(
        (current) => ({
          ...current,
          layers: current.layers.map((item) => ({
            ...item,
            boxSelected: selectedIds.includes(item.id),
          })),
        }),
        false,
      );
      const selectedBoards = [
        ...new Set(
          doc.layers
            .filter((item) => selectedIds.includes(item.id))
            .map((item) => item.artboardId)
            .filter(Boolean),
        ),
      ];
      setSelectedArtboardId(
        selectedBoards.length === 1 ? selectedBoards[0]! : null,
      );
      setContentSelectionIds(selectedIds);
      setSelectedId(selectedIds.length === 1 ? selectedIds[0] : null);
      setNotice(
        selectedIds.length
          ? `已框选 ${selectedIds.length} 个图层。`
          : "框选范围内没有图层。",
      );
    };
    stage.on("mousedown.marquee", begin);
    stage.on("mousemove.marquee", move);
    stage.on("mouseup.marquee", finish);
    return () => {
      stage.off(".marquee");
      marquee?.destroy();
    };
  }, [
    doc.layers,
    sceneId,
    pageId,
    size.width,
    size.height,
    view.x,
    view.y,
    view.z,
  ]);
  useEffect(() => {
    if (selected?.kind === "group") return;
    const stage = Konva.stages.find((candidate) =>
      Boolean(host.current && host.current.contains(candidate.container())),
    );
    const canvasLayer = stage?.getLayers()[0];
    if (!canvasLayer) return;
    const selectedIds = contentSelectionIds;
    const selectedLayers = doc.layers.filter(
      (item) =>
        selectedIds.includes(item.id) &&
        item.kind === "image" &&
        effectivelyVisible(item),
    );
    if (selectedLayers.length < 2) return;
    const x = Math.min(...selectedLayers.map((item) => item.x)),
      y = Math.min(...selectedLayers.map((item) => item.y));
    const right = Math.max(
        ...selectedLayers.map((item) => item.x + item.width),
      ),
      bottom = Math.max(...selectedLayers.map((item) => item.y + item.height));
    const bounds: Bounds = { x, y, width: right - x, height: bottom - y };
    const frame = new Konva.Rect({
      ...bounds,
      stroke: "#b6f04a",
      strokeWidth: 2,
      fill: "rgba(182,240,74,.035)",
      draggable: true,
    });
    const transformer = new Konva.Transformer({
      nodes: [frame],
      rotateEnabled: false,
      keepRatio: ratioLocked,
      flipEnabled: false,
      borderStroke: "#b6f04a",
      borderStrokeWidth: 2,
      anchorSize: 6,
      anchorStyleFunc: (anchor) => anchor.hitStrokeWidth(18 / view.z),
      anchorStroke: "#d9ff86",
      anchorStrokeWidth: 1,
      anchorFill: "#b6f04a",
      anchorCornerRadius: 1,
    });
    const toolbarWidth = 88 / view.z,
      toolbarHeight = 34 / view.z;
    const toolbar = new Konva.Group({
      x: bounds.x + bounds.width / 2 - toolbarWidth / 2,
      y: bounds.y - toolbarHeight - 8 / view.z,
      scaleX: 1 / view.z,
      scaleY: 1 / view.z,
    });
    toolbar.add(
      new Konva.Rect({
        width: 88,
        height: 34,
        fill: "#151815",
        stroke: "#343b31",
        strokeWidth: 1,
        cornerRadius: 7,
        shadowColor: "#000",
        shadowBlur: 8,
        shadowOpacity: 0.32,
      }),
    );
    toolbar.add(
      new Konva.Text({
        text: "▦  编组",
        x: 12,
        y: 8,
        fill: "#e9f5de",
        fontSize: 17,
        fontStyle: "bold",
      }),
    );
    const overallLabelText = `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;
    const overallOutline = new Konva.Text({
      text: overallLabelText,
      fontSize: 17 / view.z,
      fontStyle: "bold",
      fill: "#101510",
      stroke: "#101510",
      strokeWidth: 2.4 / view.z,
      shadowColor: "#000",
      shadowBlur: 2 / view.z,
      shadowOpacity: 0.72,
    });
    const overallText = new Konva.Text({
      text: overallLabelText,
      fontSize: 17 / view.z,
      fontStyle: "bold",
      fill: "#ffffff",
    });
    const overallLabel = new Konva.Group({
      x: bounds.x + bounds.width / 2 - overallText.width() / 2,
      y: bounds.y + bounds.height + 14 / view.z,
      listening: false,
    });
    overallLabel.add(overallOutline, overallText);
    const imageNodes = new Map<string, Konva.Image>();
    canvasLayer.find("Image").forEach((node) => {
      const layerId = node.id();
      if (layerId) imageNodes.set(layerId, node as Konva.Image);
    });
    const syncFrameVisuals = () => {
      const dx = frame.x() - bounds.x,
        dy = frame.y() - bounds.y;
      selectedLayers.forEach((item) => {
        const node = imageNodes.get(item.id);
        if (node) {
          node.x(item.x + dx);
          node.y(item.y + dy);
        }
        const label = liveLabels.current.get(item.id);
        if (label)
          label.position({
            x: item.x + dx + item.width / 2 - labelTextWidth(label) / 2,
            y: item.y + dy + item.height + 14 / view.z,
          });
      });
      toolbar.position({
        x: frame.x() + bounds.width / 2 - toolbarWidth / 2,
        y: frame.y() - toolbarHeight - 8 / view.z,
      });
      overallLabel.position({
        x: frame.x() + frame.width() / 2 - labelTextWidth(overallLabel) / 2,
        y: frame.y() + frame.height() + 14 / view.z,
      });
      canvasLayer.batchDraw();
    };
    frame.on("mousedown touchstart dragstart", (event) => {
      event.cancelBubble = true;
    });
    frame.on("dragmove", syncFrameVisuals);
    frame.on("dragend", (event) => {
      event.cancelBubble = true;
      moveMultiSelection(
        Math.round(frame.x() - bounds.x),
        Math.round(frame.y() - bounds.y),
      );
      frame.position({ x: bounds.x, y: bounds.y });
      canvasLayer.batchDraw();
    });
    frame.on("transform", () => {
      const sx = frame.scaleX(),
        sy = frame.scaleY();
      selectedLayers.forEach((item) => {
        const node = imageNodes.get(item.id);
        if (node) {
          node.x(frame.x() + (item.x - bounds.x) * sx);
          node.y(frame.y() + (item.y - bounds.y) * sy);
          node.width(item.width * sx);
          node.height(item.height * sy);
        }
        const label = liveLabels.current.get(item.id);
        if (label) {
          const labelText = `${Math.round(item.width * sx)} × ${Math.round(item.height * sy)}`;
          label
            .find("Text")
            .forEach((text) => (text as Konva.Text).text(labelText));
          label.position({
            x:
              frame.x() +
              (item.x - bounds.x) * sx +
              (item.width * sx) / 2 -
              labelTextWidth(label) / 2,
            y:
              frame.y() +
              (item.y - bounds.y) * sy +
              item.height * sy +
              14 / view.z,
          });
        }
      });
      toolbar.position({
        x: frame.x() + (bounds.width * sx) / 2 - toolbarWidth / 2,
        y: frame.y() - toolbarHeight - 8 / view.z,
      });
      const scaledWidth = bounds.width * sx,
        scaledHeight = bounds.height * sy,
        scaledText = `${Math.round(scaledWidth)} × ${Math.round(scaledHeight)}`;
      overallLabel
        .find("Text")
        .forEach((text) => (text as Konva.Text).text(scaledText));
      overallLabel.position({
        x: frame.x() + scaledWidth / 2 - labelTextWidth(overallLabel) / 2,
        y: frame.y() + scaledHeight + 14 / view.z,
      });
      canvasLayer.batchDraw();
    });
    frame.on("transformend", (event) => {
      event.cancelBubble = true;
      const sx = frame.scaleX(),
        sy = frame.scaleY(),
        x = frame.x(),
        y = frame.y();
      scaleMultiSelection(bounds, x, y, sx, sy);
      frame.scale({ x: 1, y: 1 });
      frame.position({ x, y });
      frame.size({ width: bounds.width * sx, height: bounds.height * sy });
      canvasLayer.batchDraw();
    });
    toolbar.on("click tap", (event) => {
      event.cancelBubble = true;
      groupSelectedLayers();
    });
    canvasLayer.add(frame, transformer, overallLabel, toolbar);
    canvasLayer.batchDraw();
    return () => {
      frame.destroy();
      transformer.destroy();
      overallLabel.destroy();
      toolbar.destroy();
      canvasLayer.batchDraw();
    };
  }, [
    contentSelectionIds,
    selectedId,
    doc.layers,
    ratioLocked,
    size.width,
    size.height,
    view.z,
  ]);
  useEffect(() => {
    if (!selected || selected.kind !== "image") return;
    const stage = Konva.stages.find((candidate) =>
      Boolean(host.current && host.current.contains(candidate.container())),
    );
    const canvasLayer = stage?.getLayers()[0];
    if (!canvasLayer) return;
    const label = `${Math.round(selected.width)} × ${Math.round(selected.height)}`,
      fixedFontSize = 17 / view.z;
    const outline = new Konva.Text({
      text: label,
      fontSize: fixedFontSize,
      fontStyle: "bold",
      fill: "#101510",
      stroke: "#101510",
      strokeWidth: 2.4 / view.z,
      shadowColor: "#000",
      shadowBlur: 2 / view.z,
      shadowOpacity: 0.72,
    });
    const text = new Konva.Text({
      text: label,
      fontSize: fixedFontSize,
      fontStyle: "bold",
      fill: "#ffffff",
    });
    const group = new Konva.Group({
      x: selected.x + selected.width / 2 - text.width() / 2,
      y: selected.y + selected.height + 14 / view.z,
      listening: false,
    });
    group.add(outline, text);
    canvasLayer.add(group);
    liveLabels.current.set(selected.id, group);
    canvasLayer.batchDraw();
    return () => {
      liveLabels.current.delete(selected.id);
      group.destroy();
      canvasLayer.batchDraw();
    };
  }, [selectedId, doc.layers, size.width, size.height, view.z]);
  useEffect(() => {
    if (!selected || selected.kind !== "image" || !selected.visible) return;
    const stage = Konva.stages.find((candidate) =>
        Boolean(host.current && host.current.contains(candidate.container())),
      ),
      canvasLayer = stage?.getLayers()[0];
    if (!canvasLayer) return;
    const width = 168 / view.z,
      height = 38 / view.z,
      group = new Konva.Group({
        x: selected.x + selected.width / 2 - width / 2,
        y: selected.y - height - 48 / view.z,
        scaleX: 1 / view.z,
        scaleY: 1 / view.z,
      });
    group.add(
      new Konva.Rect({
        width: 168,
        height: 38,
        fill: "#111711",
        stroke: "#41553b",
        strokeWidth: 1,
        cornerRadius: 9,
        shadowColor: "#000",
        shadowBlur: 10,
        shadowOpacity: 0.38,
      }),
    );
    group.add(
      new Konva.Text({
        text: "✦  AI 智能拆分",
        x: 16,
        y: 10,
        fill: "#b6f04a",
        fontSize: 17,
        fontStyle: "bold",
      }),
    );
    group.on("click tap", (event) => {
      event.cancelBubble = true;
      setSmartSplitOpen(true);
    });
    const syncToolbar = () => {
      const node = stage.findOne(`#${selected.id}`) as Konva.Image | undefined;
      if (!node) return;
      const widthNow = node.width() * node.scaleX(),
        heightNow = node.height() * node.scaleY();
      group.position({
        x: node.x() + widthNow / 2 - width / 2,
        y: node.y() - height - 48 / view.z,
      });
      canvasLayer.batchDraw();
    };
    stage.on("dragmove.ai-toolbar transform.ai-toolbar", syncToolbar);
    canvasLayer.add(group);
    canvasLayer.batchDraw();
    return () => {
      stage.off(".ai-toolbar");
      group.destroy();
      canvasLayer.batchDraw();
    };
  }, [selectedId, doc.layers, size.width, size.height, view.z]);
  useEffect(() => {
    const workspace = host.current,
      layersPanel = document.querySelector<HTMLElement>(".layers-panel");
    if (!workspace || !layersPanel) return;
    if (smartSplitOpen) return;
    layersPanel
      .querySelectorAll(".resource-browser")
      .forEach((item) => item.remove());
    const ownedChildren = Array.from(layersPanel.children) as HTMLElement[];
    const bar = document.createElement("nav");
    bar.className = "canvas-command-bar";
    const resources = document.createElement("section");
    resources.className = "resource-browser";
    resources.hidden = true;
    const showLayers = () => {
      layerViewMode.current = "layers";
      layersPanel.classList.remove("show-resources");
      resources.hidden = true;
      ownedChildren.forEach((item) => {
        item.style.display = "";
      });
      bar
        .querySelectorAll("button")
        .forEach((button) =>
          button.classList.toggle("active", button.dataset.mode === "layers"),
        );
    };
    const showResources = () => {
      layerViewMode.current = "resources";
      layersPanel.classList.add("show-resources");
      ownedChildren.forEach((item) => {
        item.style.display = "none";
      });
      resources.hidden = false;
      bar
        .querySelectorAll("button")
        .forEach((button) =>
          button.classList.toggle(
            "active",
            button.dataset.mode === "resources",
          ),
        );
    };
    const makeButton = (
      label: string,
      mode?: "layers" | "resources",
      action?: () => void,
    ) => {
      const button = document.createElement("button");
      button.textContent = label;
      if (mode) button.dataset.mode = mode;
      button.addEventListener("click", () => {
        if (mode === "layers") showLayers();
        if (mode === "resources") showResources();
        action?.();
      });
      return button;
    };
    bar.append(
      makeButton("▦  图层", "layers"),
      makeButton("▧  资源", "resources"),
      makeButton("✦  AI", undefined, () => setTab("ai")),
      makeButton("⇩  导入", undefined, () => file.current?.click()),
      makeButton(
        selected?.kind === "group" ? "⇧  导出组" : "⇧  导出画板",
        undefined,
        () => openPsdExport(selected?.kind === "group" ? selected.id : undefined),
      ),
      makeButton("⚒  工具箱", undefined, () =>
        setNotice("工具箱功能将在下一版开放。"),
      ),
      makeButton("↗  分享", undefined, () =>
        setNotice("分享链接功能将在下一版开放。"),
      ),
    );
    const assets = doc.layers.filter(
      (layer) => layer.kind === "image" && layer.source,
    );
    const header = document.createElement("div");
    header.className = "resource-header";
    header.innerHTML =
      '<div class="resource-title"><b>▧</b><span><small>资源库</small>资源</span></div><button class="pin">⚑</button><div class="resource-search">⌕&nbsp; 搜索资源...</div><div class="resource-tabs"><button class="active">2D 图片</button></div>';
    const controls = document.createElement("div");
    controls.className = "resource-controls";
    controls.innerHTML = `<span>(${assets.length})</span><div><button title="缩略图网格">▦</button><button title="列表">☷</button><button title="添加资源">＋</button></div>`;
    const content = document.createElement("div");
    content.className = "resource-grid";
    const renderAssets = (list = false) => {
      content.classList.toggle("list", list);
      content.replaceChildren();
      assets.forEach((layer) => {
        const card = document.createElement("button");
        card.className = "asset-card";
        const image = document.createElement("img");
        image.src = layer.source!;
        image.alt = layer.name;
        const name = document.createElement("strong");
        name.textContent = layer.name;
        const meta = document.createElement("small");
        meta.textContent = `${Math.round(layer.width)} × ${Math.round(layer.height)}`;
        card.append(image, name, meta);
        card.addEventListener("click", () => {
          setSelectedId(layer.id);
        });
        content.append(card);
      });
      if (!assets.length)
        content.innerHTML =
          '<p class="resource-empty">导入图片或 PSD 后，资源会显示在这里。</p>';
    };
    renderAssets();
    const controlButtons =
      controls.querySelectorAll<HTMLButtonElement>("button");
    controlButtons[0]?.addEventListener("click", () => renderAssets(false));
    controlButtons[1]?.addEventListener("click", () => renderAssets(true));
    controlButtons[2]?.addEventListener("click", () => file.current?.click());
    resources.append(header, controls, content);
    layersPanel.append(resources);
    workspace.append(bar);
    if (layerViewMode.current === "resources") showResources();
    else showLayers();
    return () => {
      bar.remove();
      resources.remove();
      layersPanel.classList.remove("show-resources");
      ownedChildren.forEach((item) => {
        item.style.display = "";
      });
    };
  }, [doc.layers, doc.artboards, activeArtboard?.id, selectedId, smartSplitOpen]);
  useEffect(() => {
    document
      .querySelectorAll<HTMLLabelElement>(
        ".dimension-row label, .dimension-row + .property-grid label",
      )
      .forEach((label) => {
        if (label.dataset.inlineField) return;
        const input = label.querySelector("input");
        const caption = Array.from(label.childNodes)
          .find(
            (node) =>
              node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
          )
          ?.textContent?.trim();
        if (!input || !caption) return;
        Array.from(label.childNodes).forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) node.textContent = "";
        });
        const prefix = document.createElement("span");
        prefix.className = "field-inline-label";
        prefix.textContent = caption;
        label.insertBefore(prefix, input);
        label.dataset.inlineField = "true";
      });
  }, [selectedId, doc.layers]);
  useEffect(() => {
    const section = Array.from(
      document.querySelectorAll<HTMLElement>(".properties section"),
    ).find((item) => item.querySelector("h4")?.textContent?.startsWith("位置"));
    const grid = section?.querySelector<HTMLElement>(".property-grid");
    if (!section || !grid || !selected) return;
    section
      .querySelectorAll(".position-alignments,.position-transforms")
      .forEach((item) => item.remove());
    const alignments = document.createElement("div");
    alignments.className = "position-alignments";
    const actions: Array<[string, Parameters<typeof alignLayers>[0]]> =
      [
        ["左对齐", "left"],
        ["水平居中", "centerX"],
        ["右对齐", "right"],
        ["顶对齐", "top"],
        ["垂直居中", "centerY"],
        ["底对齐", "bottom"],
        ["水平等距", "spaceX"],
        ["垂直等距", "spaceY"],
      ];
    actions.forEach(([title, mode]) => {
      const button = document.createElement("button");
      button.title = title;
      button.setAttribute("aria-label", title);
      button.append(createAlignmentIcon(mode));
      button.addEventListener("click", () => alignLayers(mode));
      alignments.append(button);
    });
    const transforms = document.createElement("div");
    transforms.className = "position-transforms";
    const transformActions: Array<
      [string, string, "flipX" | "flipY" | "rotate90"]
    > = [
      ["水平翻转", "⇋", "flipX"],
      ["垂直翻转", "⇵", "flipY"],
      ["顺时针旋转 90°", "↻ 90°", "rotate90"],
    ];
    transformActions.forEach(([title, icon, mode]) => {
      const button = document.createElement("button");
      button.title = title;
      button.textContent = icon;
      button.disabled = selected.kind !== "image";
      button.addEventListener("click", () => transformSelectedBitmap(mode));
      transforms.append(button);
    });
    section.insertBefore(alignments, grid);
    grid.insertAdjacentElement("afterend", transforms);
    return () => {
      alignments.remove();
      transforms.remove();
    };
  }, [selectedId, contentSelectionIds, doc.layers]);
  const renderLayerRows = (
    parentId: string | null,
    depth = 0,
    artboardId?: string | null,
  ): ReactNode[] =>
    doc.layers
      .filter(
        (layer) =>
          layer.parentId === parentId &&
          (artboardId === undefined
            ? true
            : artboardId === null
              ? !layer.artboardId
              : layer.artboardId === artboardId),
      )
      .sort((a, b) => a.zIndex - b.zIndex)
      .flatMap((layer) => {
        const isCollapsed = collapsedGroups.includes(layer.id),
          isSelected =
            layer.id === selectedId || contentSelectionIds.includes(layer.id);
        const row = (
          <div
            key={layer.id}
            className={`layer-row ${isSelected ? "selected" : ""}`}
            data-layer-id={layer.id}
            draggable
            onMouseEnter={() => setHoveredLayerId(layer.id)}
            onMouseLeave={() =>
              setHoveredLayerId((current) =>
                current === layer.id ? null : current,
              )
            }
            onClick={(event) => {
              if (suppressTreeClick.current) {
                suppressTreeClick.current = false;
                return;
              }
              selectLayer(layer, {
                toggle: event.ctrlKey || event.metaKey,
                range: event.shiftKey,
              });
            }}
            style={{ paddingLeft: `${7 + depth * 18}px` }}
          >
            {layer.kind === "group" ? (
              <button
                className="layer-toggle"
                aria-label={isCollapsed ? "展开组" : "收起组"}
                onClick={(event) => {
                  event.stopPropagation();
                  setCollapsedGroups((groups) =>
                    isCollapsed
                      ? groups.filter((id) => id !== layer.id)
                      : [...groups, layer.id],
                  );
                }}
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
            ) : (
              <span className="layer-toggle" />
            )}
            <span className="layer-icon">
              {layer.kind === "selection"
                ? "◇"
                : layer.kind === "group"
                  ? "▦"
                  : layer.kind === "text"
                    ? "T"
                    : "▣"}
            </span>
            <span className="layer-name">{layer.name}</span>
            <span
              className="layer-actions"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                aria-label={layer.visible ? "隐藏" : "显示"}
                onClick={() => patch(layer.id, { visible: !layer.visible })}
              >
                <VisibilityIcon visible={layer.visible} />
              </button>
              <button
                className="layer-lock-button"
                aria-label={layer.locked ? "解锁" : "锁定"}
                onClick={() => patch(layer.id, { locked: !layer.locked })}
              >
                <LockIcon locked={layer.locked} />
              </button>
            </span>
          </div>
        );
        return [
          row,
          ...(layer.kind === "group" && !isCollapsed
            ? renderLayerRows(layer.id, depth + 1, artboardId)
            : []),
        ];
      });
  const renderArtboardRows = (): ReactNode[] =>
    doc.artboards.flatMap((artboard) => {
      const collapsed = collapsedArtboards.includes(artboard.id),
        active = artboard.id === activeArtboard?.id;
      const row = (
        <div
          key={`artboard-${artboard.id}`}
          className={`layer-row artboard-row ${active && !selected ? "selected" : ""}`}
          data-artboard-id={artboard.id}
          onClick={() => selectArtboard(artboard.id)}
        >
          <button
            className="layer-toggle"
            aria-label={collapsed ? "展开画板" : "收起画板"}
            onClick={(event) => {
              event.stopPropagation();
              setCollapsedArtboards((items) =>
                collapsed
                  ? items.filter((id) => id !== artboard.id)
                  : [...items, artboard.id],
              );
            }}
          >
            {collapsed ? "▸" : "▾"}
          </button>
          <span className="layer-icon">#</span>
          <span className="layer-name">{artboard.name}</span>
          <small>
            {artboard.width} × {artboard.height}
          </small>
        </div>
      );
      return [row, ...(collapsed ? [] : renderLayerRows(null, 1, artboard.id))];
    });
  const renderOutsideRows = (): ReactNode[] => {
    const outsideLayers = renderLayerRows(null, 1, null);
    return [
      <div
        key="outside-layers"
        className="layer-row outside-row"
        data-outside-drop="true"
      >
        <span className="layer-toggle" />
        <span className="layer-icon">↗</span>
        <span className="layer-name">画板外</span>
        <small>{outsideLayers.length}</small>
      </div>,
      ...outsideLayers,
    ];
  };
  const renderCanvasGroup = (group: LayerNode) => (
                  <CanvasGroupFrame
                    key={`group-frame-${group.id}`}
                    group={group}
                    children={descendants(group.id).filter(
                      (layer) => layer.kind === "image" || layer.kind === "text",
                    )}
                    selected={
                      group.id === selectedId ||
                      contentSelectionIds.includes(group.id)
                    }
                    viewScale={view.z}
                    select={(event) => {
                      const pointer = event.evt as MouseEvent;
                      selectLayer(group, {
                        toggle: pointer.ctrlKey || pointer.metaKey,
                        range: pointer.shiftKey,
                      });
                    }}
                    hover={setHoveredLayerId}
                    move={(dx, dy) => moveGroup(group.id, dx, dy)}
                    resize={(bounds) => patch(group.id, bounds)}
                  />
  );
  const renderCanvasArtboard = (
    artboard: DocumentState["artboards"][number],
  ) => {
    const titleHeight = 20 / view.z,
      titleWidth = Math.min(artboard.width, 280 / view.z),
      titleY = artboard.y - titleHeight - 5 / view.z;
    const boardLayers = ordered.filter(
      (layer) => layer.artboardId === artboard.id,
    );
    const contentId = `artboard-content-${artboard.id}`;
    return (
      <Group key={artboard.id}>
        <Group id={contentId}>
          <ArtboardCanvas
            artboard={artboard}
            selected={
              artboard.id === selectedArtboardId &&
              selectedId === null &&
              contentSelectionIds.length === 0
            }
              viewScale={view.z}
            select={() => selectArtboard(artboard.id)}
            resize={(bounds) => setArtboardBounds(artboard.id, bounds)}
          >
            {boardLayers.map((layer) =>
              layer.kind === "group" ? null : (
                <Sprite
                  key={layer.id}
                  layer={
                    effectivelyVisible(layer)
                      ? layer
                      : { ...layer, visible: false }
                  }
                  selected={
                    layer.id === selectedId ||
                    contentSelectionIds.includes(layer.id)
                  }
                  keepRatio={ratioLocked}
                  hover={setHoveredLayerId}
                  select={(event) => {
                    const pointer = event.evt as MouseEvent;
                    selectLayer(layer, {
                      toggle: pointer.ctrlKey || pointer.metaKey,
                      range: pointer.shiftKey,
                    });
                  }}
                  patch={(value) => patch(layer.id, value)}
                  drop={(x, y) => dropLayer(layer.id, x, y)}
                  sync={syncLiveLayer}
                />
              ),
            )}
          </ArtboardCanvas>
          {boardLayers.filter(layer => layer.kind === "group").map(renderCanvasGroup)}
        </Group>
        <Group
          x={artboard.x}
          y={titleY}
          width={titleWidth}
          height={titleHeight}
          draggable
          onClick={(event) => {
            event.cancelBubble = true;
            selectArtboard(artboard.id);
          }}
          onDragStart={(event) => {
            event.cancelBubble = true;
          }}
          onDragMove={(event) => {
            event.cancelBubble = true;
            const content = event.target.getStage()?.findOne(`#${contentId}`);
            content?.position({
              x: event.currentTarget.x() - artboard.x,
              y: event.currentTarget.y() - titleY,
            });
            content?.getLayer()?.batchDraw();
          }}
          onDragEnd={(event) => {
            event.cancelBubble = true;
            const dx = event.currentTarget.x() - artboard.x,
              dy = event.currentTarget.y() - titleY;
            const content = event.target.getStage()?.findOne(`#${contentId}`);
            content?.position({ x: 0, y: 0 });
            event.currentTarget.position({ x: artboard.x, y: titleY });
            moveArtboard(artboard.id, dx, dy);
            selectArtboard(artboard.id);
          }}
        >
          <Rect
            width={titleWidth}
            height={titleHeight}
            fill="rgba(0,0,0,0.001)"
          />
          <KText
            x={2 / view.z}
            y={4 / view.z}
            width={titleWidth - 4 / view.z}
            text={`▦ ${artboard.name}`}
            fill={artboard.id === activeArtboard?.id ? "#b6f04a" : "#bac5b7"}
            fontSize={11 / view.z}
            ellipsis
            wrap="none"
          />
        </Group>
      </Group>
    );
  };
  const floatingLayers = ordered.filter((layer) => !layer.artboardId);
  const canvasGroups = floatingLayers.filter((layer) => layer.kind === "group");
  const exportGroupId = selected?.kind === "group" ? selected.id : undefined;
  return (
    <div className="app-shell" onClick={() => setMenu(null)}>
      <header>
        <div className="brand">
          <b>LC</b>
          <strong>Layer Canvas</strong>
          <span>FIRST EDITION</span>
        </div>
        <div className="toolbar">
          <button onClick={() => file.current?.click()}>导入图片</button>
          <button disabled={!activeArtboard} onClick={addSelection}>
            新建选区
          </button>
          <button disabled={selected?.kind !== "selection"} onClick={extract}>
            提取选区
          </button>
          <button onClick={resetSavedWorkspace}>清除保存</button>
        </div>
        <div className="exports">
          <button
            disabled={!activeArtboard}
            onClick={() => exportJson(doc, activeArtboard?.id, exportGroupId).catch(e => setNotice(e.message))}
          >
            {exportGroupId ? "导出组 JSON" : "导出画板 JSON"}
          </button>
          <button
            disabled={!activeArtboard}
            onClick={() => openPsdExport(exportGroupId)}
          >
            {exportGroupId ? "导出组 PSD" : "导出画板 PSD"}
          </button>
          <button
            disabled={!activeArtboard}
            onClick={() => exportEngineZip(doc, 'unity', activeArtboard?.id, exportGroupId).catch(e => setNotice(e.message))}
          >
            {exportGroupId ? "组 Unity 包" : "画板 Unity 包"}
          </button>
          <button
            disabled={!activeArtboard}
            onClick={() => exportEngineZip(doc, 'cocos', activeArtboard?.id, exportGroupId).catch(e => setNotice(e.message))}
          >
            {exportGroupId ? "组 Cocos 包" : "画板 Cocos 包"}
          </button>
          <button
            disabled={!activeArtboard}
            onClick={() => exportEngineZip(doc, 'godot', activeArtboard?.id, exportGroupId).catch(e => setNotice(e.message))}
          >
            {exportGroupId ? "组 Godot 包" : "画板 Godot 包"}
          </button>
        </div>
      </header>
      <input
        ref={file}
        type="file"
        accept="image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.avif,.ico,.psd"
        multiple
        hidden
        onChange={(e) => {
          Array.from(e.target.files || []).forEach(upload);
          e.target.value = "";
        }}
      />
      <main>
        <aside className="layers-panel">
          <div className="panel-title">
            <div>
              <small className="micro">工作区</small>
              <span>图层</span>
            </div>
            <button className="pin">⚑</button>
          </div>
          <div className="scene-heading">
            <span>
              场景 <b>{scenes.length}</b>
            </span>
            <button onClick={() => addPage(scene.id)}>＋</button>
          </div>
          <div className="scene-search">⌕ 搜索场景...</div>
          <div className="page-list">
            {scenes.map((s) => (
              <div key={s.id}>
                <div className="scene-name">
                  ▦ {s.name}
                  <button onClick={() => addPage(s.id)}>＋</button>
                </div>
                {s.pages.map((p) => (
                  <button
                    key={p.id}
                    className={`page-row ${p.id === page.id ? "active" : ""}`}
                    onClick={() => choose(s.id, p.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, s: s.id, p: p.id });
                    }}
                  >
                    ▦ {p.name}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="layer-search">⌕ 搜索图层...</div>
          <div className="tree">
            {renderArtboardRows()}
            {renderOutsideRows()}
          </div>
        </aside>
        <section
          className="workspace"
          ref={host}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            Array.from(e.dataTransfer.files).forEach(upload);
          }}
        >
          <div className="notice">{notice}</div>
          <Stage
            width={size.width}
            height={size.height}
            x={view.x}
            y={view.y}
            scaleX={view.z}
            scaleY={view.z}
            draggable={false}
            onWheel={wheel}
          >
            <Layer>
              <Group>{doc.artboards.map(renderCanvasArtboard)}</Group>
              <Group>
                {floatingLayers.map((layer) =>
                  layer.kind === "group" ? null : (
                    <Sprite
                      key={layer.id}
                      layer={
                        effectivelyVisible(layer)
                          ? layer
                          : { ...layer, visible: false }
                      }
                      selected={
                        layer.id === selectedId ||
                        contentSelectionIds.includes(layer.id)
                      }
                      keepRatio={ratioLocked}
                      hover={setHoveredLayerId}
                      select={(event) => {
                        const pointer = event.evt as MouseEvent;
                        selectLayer(layer, {
                          toggle: pointer.ctrlKey || pointer.metaKey,
                          range: pointer.shiftKey,
                        });
                      }}
                      patch={(value) => patch(layer.id, value)}
                      drop={(x, y) => dropLayer(layer.id, x, y)}
                      sync={syncLiveLayer}
                    />
                  ),
                )}
              </Group>
              <Group>
                {canvasGroups.map(renderCanvasGroup)}
              </Group>
              {hoveredLayer && hoveredLayerBounds && hoveredLayer.kind !== "selection" && (
                <Group
                  x={hoveredLayerBounds.x}
                  y={hoveredLayerBounds.y}
                  rotation={hoveredLayerBounds.rotation || 0}
                  listening={false}
                >
                  <Rect
                    width={hoveredLayerBounds.width}
                    height={hoveredLayerBounds.height}
                    stroke="#b6f04a"
                    strokeWidth={2 / view.z}
                    listening={false}
                  />
                  <KText
                    y={-20 / view.z}
                    width={Math.min(Math.max(80 / view.z, hoveredLayerBounds.width), 220 / view.z)}
                    height={16 / view.z}
                    text={hoveredLayer.name}
                    fill="#b6f04a"
                    fontSize={12 / view.z}
                    fontStyle="bold"
                    ellipsis
                    wrap="none"
                    listening={false}
                  />
                </Group>
              )}
              {selected?.kind === "image" && (
                <FloatingImageTransformer
                  layer={selected}
                  keepRatio={ratioLocked}
                  viewScale={view.z}
                />
              )}
              {selected?.kind === "text" && (
                <FloatingTextTransformer layer={selected} viewScale={view.z} />
              )}
            </Layer>
          </Stage>
          <div className="zoom">
            {Math.round(view.z * 100)}% · 滚轮缩放 · 拖动画布
          </div>
        </section>
        <aside className="inspector">
          <div className="tabs">
            <button
              className={tab === "design" ? "active" : ""}
              onClick={() => setTab("design")}
            >
              设计
            </button>
            <button
              className={tab === "note" ? "active" : ""}
              onClick={() => setTab("note")}
            >
              笔记
            </button>
            <button
              className={tab === "ai" ? "active" : ""}
              onClick={() => setTab("ai")}
            >
              AI
            </button>
          </div>
          {tab === "design" &&
            (selected ? (
              <div className="properties">
                <div className="object-title">
                  <select disabled>
                    <option>{selected.kind}</option>
                  </select>
                  <b>{selected.name}</b>
                </div>
                {activeArtboard && (
                  <div className="artboard-chip">
                    画板 · {activeArtboard.name}
                  </div>
                )}
                <div className="inline-toggles">
                  <label>
                    可见性{" "}
                    <input
                      type="checkbox"
                      checked={selected.visible}
                      onChange={() =>
                        patch(selected.id, { visible: !selected.visible })
                      }
                    />
                  </label>
                  <label>
                    锁定{" "}
                    <button
                      onClick={() =>
                        patch(selected.id, { locked: !selected.locked })
                      }
                    >
                      {selected.locked ? "⌁" : "⌑"}
                    </button>
                  </label>
                </div>
                <section>
                  <h4>位置（画板坐标）</h4>
                  <div className="property-grid position-field-grid">
                    {field("X", "x", selected.x - (activeArtboard?.x ?? 0), true)}
                    {field("Y", "y", selected.y - (activeArtboard?.y ?? 0), true)}
                    {field("旋转", "rotation", selected.rotation || 0, true)}
                    {field("层级", "zIndex", selected.zIndex, true)}
                  </div>
                </section>
                <section>
                  <h4>布局</h4>
                  <div className="dimension-row">
                    <label>
                      W
                      <input
                        type="number"
                        value={selected.width}
                        onChange={(e) => resize("width", +e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className={`ratio-lock ${ratioLocked ? "locked" : ""}`}
                      title={ratioLocked ? "解锁宽高比例" : "锁定宽高比例"}
                      aria-label={ratioLocked ? "解锁宽高比例" : "锁定宽高比例"}
                      onClick={() => setRatioLocked((x) => !x)}
                    >
                      🔗
                    </button>
                    <label>
                      H
                      <input
                        type="number"
                        value={selected.height}
                        onChange={(e) => resize("height", +e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="property-grid">
                    {field("圆角", "radius", selected.radius || 0)}
                    <label>
                      不透明度
                      <input
                        type="number"
                        value={Math.round((selected.opacity ?? 1) * 100)}
                        onChange={(e) =>
                          patch(selected.id, { opacity: +e.target.value / 100 })
                        }
                      />
                    </label>
                  </div>
                </section>
                {selected.kind === "text" && (
                  <section className="text-layer-properties">
                    <h4>原生文字</h4>
                    <label>
                      文字内容
                      <textarea
                        className="text-content-editor"
                        value={selected.textContent || ""}
                        onChange={(event) => patch(selected.id, { textContent: event.target.value })}
                      />
                    </label>
                    <label>
                      字体族
                      <input
                        value={selected.textStyle?.fontFamily || "Arial"}
                        onChange={(event) => patch(selected.id, { textStyle: { ...selected.textStyle, fontFamily: event.target.value } })}
                      />
                    </label>
                    <div className="property-grid">
                      <label>
                        字号
                        <input type="number" min="1" value={selected.textStyle?.fontSize || 24} onChange={(event) => patch(selected.id, { textStyle: { ...selected.textStyle, fontSize: Math.max(1, Number(event.target.value) || 1) } })} />
                      </label>
                      <label>
                        行高比例
                        <input type="number" min="0.5" step="0.1" value={selected.textStyle?.lineHeight || 1.2} onChange={(event) => patch(selected.id, { textStyle: { ...selected.textStyle, lineHeight: Math.max(0.5, Number(event.target.value) || 0.5) } })} />
                      </label>
                      <label>
                        字间距
                        <input type="number" step="0.5" value={selected.textStyle?.letterSpacing || 0} onChange={(event) => patch(selected.id, { textStyle: { ...selected.textStyle, letterSpacing: Number(event.target.value) || 0 } })} />
                      </label>
                      <label>
                        水平对齐
                        <select value={selected.textStyle?.align || "left"} onChange={(event) => patch(selected.id, { textStyle: { ...selected.textStyle, align: event.target.value as TextLayerStyle["align"] } })}>
                          <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
                        </select>
                      </label>
                    </div>
                    <div className="text-style-toggles">
                      <label><input type="checkbox" checked={selected.textStyle?.bold || false} onChange={(event) => patch(selected.id, { textStyle: { ...selected.textStyle, bold: event.target.checked } })} /> 粗体</label>
                      <label><input type="checkbox" checked={selected.textStyle?.italic || false} onChange={(event) => patch(selected.id, { textStyle: { ...selected.textStyle, italic: event.target.checked } })} /> 斜体</label>
                    </div>
                    <div className="text-color-row">
                      <label>文字色<input type="color" value={selected.textStyle?.color || "#ffffff"} onChange={(event) => patch(selected.id, { textStyle: { ...selected.textStyle, color: event.target.value } })} /></label>
                      <label>描边色<input type="color" value={selected.textStyle?.strokeColor || "#000000"} onChange={(event) => patch(selected.id, { textStyle: { ...selected.textStyle, strokeColor: event.target.value } })} /></label>
                      <label>描边宽<input type="number" min="0" step="0.5" value={selected.textStyle?.strokeWidth || 0} onChange={(event) => patch(selected.id, { textStyle: { ...selected.textStyle, strokeWidth: Math.max(0, Number(event.target.value) || 0) } })} /></label>
                    </div>
                  </section>
                )}
                <details>
                  <summary>
                    自动布局 <span>＋</span>
                  </summary>
                  <p>图层坐标相对于所属画板。</p>
                </details>
                <details open>
                  <summary>
                    填充 <span>＋</span>
                  </summary>
                  <label className="color-row">
                    <input
                      type="color"
                      value={selected.fill || "#ffffff"}
                      onChange={(e) =>
                        patch(selected.id, { fill: e.target.value })
                      }
                    />
                    <input
                      value={selected.fill || "#FFFFFF"}
                      onChange={(e) =>
                        patch(selected.id, { fill: e.target.value })
                      }
                    />
                    <span>{Math.round((selected.opacity ?? 1) * 100)}%</span>
                  </label>
                </details>
                <details>
                  <summary>
                    图像调整 <span>›</span>
                  </summary>
                  <p>后续接入调整与局部重绘。</p>
                </details>
                <details>
                  <summary>
                    约束 <span>›</span>
                  </summary>
                </details>
                <details>
                  <summary>
                    描边 <span>＋</span>
                  </summary>
                </details>
                <details>
                  <summary>
                    效果 <span>＋</span>
                  </summary>
                </details>
              </div>
            ) : (
              <div className="empty inspector-empty">
                从画布或左侧图层
                <br />
                选择一个对象
              </div>
            ))}
          {tab === "note" && (
            <div className="properties note-panel">
              <h3>{selected?.name || "Page 笔记"}</h3>
              <textarea
                disabled={!selected}
                value={selected?.note || ""}
                placeholder="记录功能逻辑、修改意见或交付说明…"
                onChange={(e) =>
                  selected && patch(selected.id, { note: e.target.value })
                }
              />
            </div>
          )}
          {tab === "ai" && (
            <div className="properties ai-panel">
              <div className="ai-mark">✦</div>
              <h3>图层拆分</h3>
              <p>API 拆分与 ComfyUI 本地拆分相互独立，可在配置页切换。</p>
              <button
                disabled={selected?.kind !== "image"}
                onClick={() => setSmartSplitOpen(true)}
              >
                配置拆分
              </button>
            </div>
          )}
        </aside>
      </main>
      {smartSplitPortal}
      {psdExportRequest && <Suspense fallback={<div className="psd-export-overlay" role="status">正在加载 PSD 导出…</div>}><PsdExportDialog
        document={psdExportRequest.document}
        artboardId={psdExportRequest.artboardId}
        groupId={psdExportRequest.groupId}
        onClose={() => setPsdExportRequest(null)}
        onExported={setNotice}
      /></Suspense>}
      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              rename(menu.s, menu.p);
              setMenu(null);
            }}
          >
            重命名
          </button>
          <button
            onClick={() => {
              copy(menu.s, menu.p);
              setMenu(null);
            }}
          >
            创建副本
          </button>
          <hr />
          <button
            className="danger"
            onClick={() => {
              drop(menu.s, menu.p);
              setMenu(null);
            }}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}
