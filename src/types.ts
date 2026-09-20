export type LayerKind = 'image' | 'group' | 'selection';

export type LayerNode = {
  id: string;
  name: string;
  kind: LayerKind;
  parentId: string | null;
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
};

export type DocumentState = {
  version: '1.0';
  canvas: { width: number; height: number };
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
