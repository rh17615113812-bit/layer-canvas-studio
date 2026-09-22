export type LayerKind = 'image' | 'group' | 'selection';

export type LayerNode = {
  id: string;
  name: string;
  kind: LayerKind;
  parentId: string | null;
  /** 图层所属画板。x/y 仍是工作区坐标，导出时换算为画板内坐标。 */
  artboardId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  visible: boolean;
  locked: boolean;
  rotation?: number;
  radius?: number;
  opacity?: number;
  fill?: string;
  note?: string;
  source?: string;
  /** 原始 PNG/JPEG 像素尺寸；布局 width/height 是画布中的显示尺寸。 */
  assetWidth?: number;
  assetHeight?: number;
  /** 仅用于当前画布会话的多选拖动状态，不影响导出文件。 */
  boxSelected?: boolean;
  /** 组框已经使用新版本的独立可编辑边界；缺失时会从旧数据迁移一次。 */
  boundsMode?: 'manual';
};

export type Artboard = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DocumentState = {
  version: '1.0';
  canvas: { width: number; height: number };
  artboards: Artboard[];
  layers: LayerNode[];
};

export type PageState = {
  id: string;
  name: string;
  document: DocumentState;
};

export type SceneState = {
  id: string;
  name: string;
  pages: PageState[];
};
