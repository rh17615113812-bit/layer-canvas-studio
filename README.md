# Layer Canvas — 第一版

本地运行：

```powershell
npm install
npm run dev
```

接入 Seedream 5.0 Pro 图层拆分（火山方舟 Agent Plan 个人版）：

```powershell
Copy-Item .env.example .env.local
# 编辑 .env.local，填入 ARK_API_KEY；不要把密钥放入前端或提交到 Git。
npm run api
```

保持 `npm run dev` 和 `npm run api` 两个终端同时运行。打开右侧 `AI` 页签并点击“配置 AI 拆分”即可调用。该请求会向 Agent Plan 专属 `https://ark.cn-beijing.volces.com/api/plan/v3/images/generations` 端点发送 `layer_decomposition: true`，使用 `doubao-seedream-5-0-pro`，并把返回的透明 PNG、名称、z-index 与 bounding box 写回当前 Page 的图层树。

功能：导入 PNG/JPG/WebP；无限画布缩放/平移；场景 > Page 的多画布管理；每个 Page 独立保存图层、画布与选中状态；场景右侧可新建 Page；右键 Page 可重命名、创建副本或删除；左侧图层树；选中图片显示可拖拽四角锚点；锁定/解锁宽高比例；选择、移动、缩放、隐藏、锁定、改名；手动选区提取独立 PNG；右侧设计/笔记/AI 属性区；导出画板或图层组的 JSON、PSD、Unity、Cocos、Godot 包。

点击“导出画板 PSD”或“导出组 PSD”会先打开二级弹窗。可修改文件名、查看完整画板预览，并在下载前点击“验证”回读 PSD 的尺寸、图层数量及可编辑文字图层数量。默认保留可编辑文字并启用 Photoshop 打开时重建文字图层；只有勾选“文字栅格化（全部像素）”才会把文字转成普通像素图层。预览与 PSD 的合成图使用同一绘制流程。验证属于文件结构检查，最终显示效果仍需在 Photoshop 中查看。

本地 ComfyUI 和 RunningHub 框选拆分会逐框运行原有工作流，并额外将整张原图提交一次背景分离工作流。背景提示词及对应的文本节点 ID / 字段单独配置；提示词只覆盖整图背景请求，逐框请求继续使用工作流内默认提示词。RunningHub 模式会额外创建一次工作流任务。

当前“提取选区”是本地无 AI 的基线流程：它从已锁定的原始图层裁切出独立 PNG。后续接入 AI 时，只需将模型返回的 PNG、坐标、名称和层级写入当前 Page 的 `DocumentState.layers` 数组，左侧图层与画布会同步更新。

引擎导出包共享同一份 `layout.json` 与图片图层的透明 PNG。`layout.json` 保留名称、分组父子关系、位置、尺寸、绘制顺序、显示状态、旋转、透明度及文字原文和样式。**文字不生成 PNG**，在 Unity 中导出为 `UI.Text`，在 Cocos 中导出为 `Label`，在 Godot 中导出为 `Label`，可在引擎编辑器中继续修改。画板导出坐标以画板左上角为原点；组导出以组边界左上角为原点。

- Unity：解压完整目录到 `Assets`。`Editor/LayerCanvasImporter.cs` 在导入 `layout.json` 时生成 Prefab；将 Prefab 拖进场景。若先导入了 JSON 再导入脚本，选中 JSON，运行 `Tools > Layer Canvas > Rebuild selected layout`。
- Cocos Creator 3.8：按导出包内 `README.txt` 指定的专属目录，将 `layout.json`、`images/` 放进 `assets/resources`，将导入脚本放进 `assets`。在 Canvas 下新建空节点并添加组件；编辑器会创建分组和图片节点。确认后把根节点拖入 Assets 保存为 Prefab。若 PNG 没有 `spriteFrame` 子资源，先在资源检查器中把图片类型设为 `sprite-frame`。
- Godot 4：把 ZIP 内容解压到项目根目录。将 `.tscn` 拖进场景；`images/` 需保留在项目根目录。原始图层属性可在 `layout.json` 查阅。

三种引擎采用各自的画布缩放设置。要按像素对齐，请把引擎参考分辨率设为导出的画板宽高，并将导入根节点放在画布左上角。Cocos 的分组若与组外图层在 z-index 上交错，导出会提示先调整图层顺序。导入后仍需在目标引擎中做视觉验收。

程序文字会映射字体名称、字号、颜色、粗斜体、水平和垂直对齐、行距、描边等属性。目标项目需要安装或导入相应字体；不同引擎的字体度量、自动换行和字距实现并不完全相同，因此文字可编辑不等于未经校对就能保证像素级一致。Unity `UI.Text` 不提供原生字距属性，原始 `letterSpacing` 仍保留在 `layout.json` 中。
