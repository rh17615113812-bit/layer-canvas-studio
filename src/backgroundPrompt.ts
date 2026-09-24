export const DEFAULT_BACKGROUND_PROMPT =
  '只保留原图中的场景背景，去除所有游戏 UI 元素，包括文字、按钮、图标、面板、边框、徽标、进度条及其阴影和发光效果。补全 UI 元素遮挡的区域，使背景纹理、颜色、光照和空间关系自然延续。保持原图的画布尺寸、构图和背景内容，不保留或重绘任何 UI 元素。只输出填满整张画布的背景图。';

export type WorkflowPromptOverride = {
  nodeId: string;
  fieldName: string;
  prompt: string;
};
