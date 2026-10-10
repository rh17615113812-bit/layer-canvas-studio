export type RegionPromptPayload = {
  rewritten_prompt: string;
  wh_ratio: '';
  ratio_follow: '<image1>';
};

const CLEAN_PANEL_PROMPT = '去掉所有文字、周边场景元素、其它 UI 元素、遮挡物以及残留杂边与半透明脏边，使最终画面中只保留该面板主体本身。保持面板主体原有的描边样式、描边宽度、外发光颜色与扩散范围、内部渐变、高光、阴影、材质质感与整体长宽比例及各部分相对位置完全不变，输入图像是唯一的风格参考，不重新设计、不改变风格、不重新绘制、不重新解释该面板。在完全保持原有样式不变的前提下提升画面清晰度，修复模糊使主体边缘干净、结构锐利、描边与发光层次清晰可辨。输出带 alpha 通道的透明背景 PNG，背景区域为全透明，主体轮廓之外的所有像素均为全透明，主体边缘保留干净的抗锯齿。';

const OCCLUDED_PANEL_PROMPT = '移除图像中红色半透明遮罩标注框所指区域内的全部内容，并将该区域补全为该 UI 面板原本的空白底板状态：补全出的部分在造型、边框结构、填充色、渐变走向、阴影投射、高光位置与材质质感上与紧邻的可见部分完全一致，仿佛该区域本来就存在且从未放置过任何内容；补全后的表面保留原有的自边缘向内加深的底色渐变与底层质感纹理。画面中不残留任何红色标记。补全完成后，去掉所有文字、周边场景元素、其它 UI 元素、遮挡物以及残留杂边与半透明脏边，使最终画面中只保留该面板主体本身。保持面板主体原有的描边样式、描边宽度、外发光颜色与扩散范围、内部渐变、高光、阴影、材质质感与整体长宽比例及各部分相对位置完全不变，输入图像是唯一的风格参考，不重新设计、不改变风格、不重新绘制、不重新解释该面板。在完全保持原有样式不变的前提下提升画面清晰度，修复模糊使主体边缘干净、结构锐利、描边与发光层次清晰可辨。输出带 alpha 通道的透明背景 PNG，背景区域为全透明，主体轮廓之外的所有像素均为全透明，主体边缘保留干净的抗锯齿。';

const KEEP_ORIGINAL_TEXT_PROMPT = '去掉UI元素以外的背景，保持UI元素主体原有的描边样式、描边宽度、外发光颜色与扩散范围、内部渐变、高光、阴影、材质质感与整体长宽比例及各部分相对位置完全不变，输入图像是唯一的风格参考，不重新设计、不改变风格、不重新绘制、不重新解释该元素。在完全保持原有样式不变的前提下提升画面清晰度，修复模糊使主体边缘干净、结构锐利、描边与发光层次清晰可辨。输出带 alpha 通道的透明背景 PNG，背景区域为全透明，主体轮廓之外的所有像素均为全透明，主体边缘保留干净的抗锯齿。';

export const regionPromptPayload = (hasUpperOcclusion: boolean, preserveOriginalText = false): RegionPromptPayload => ({
  rewritten_prompt: hasUpperOcclusion ? OCCLUDED_PANEL_PROMPT : preserveOriginalText ? KEEP_ORIGINAL_TEXT_PROMPT : CLEAN_PANEL_PROMPT,
  wh_ratio: '',
  ratio_follow: '<image1>',
});

/** Serialize the structured prompt for a ComfyUI text input node. */
export const regionPromptForBox = (hasUpperOcclusion: boolean, preserveOriginalText = false) =>
  JSON.stringify(regionPromptPayload(hasUpperOcclusion, preserveOriginalText));
