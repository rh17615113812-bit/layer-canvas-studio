export type SmartSplitKind = 'ui' | 'text';
export type SmartSplitBoxData = { type: SmartSplitKind; shouldSplit?: boolean };

export const DEFAULT_VISION_INSTRUCTION = '识别可独立编辑的游戏 UI 元素与程序文字；忽略背景、完整画布、装饰碎片、微小噪声和重复区域。标题要简洁并可直接作为图层名；按钮、面板、图标等归类为 ui，文本和程序字归类为 text。';

export const isSplittableBox = (box: SmartSplitBoxData) => box.type === 'ui' && box.shouldSplit !== false;
export const selectSplittableBoxes = <T extends SmartSplitBoxData>(boxes: T[]) => boxes.filter(isSplittableBox);
