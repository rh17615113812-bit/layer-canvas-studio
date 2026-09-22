# Layer Canvas Studio — Handoff

更新时间：2026-09-21（Asia/Shanghai）
项目目录：`C:\Users\Renhao\Documents\ChatGPT\图层拆分工具`
远端仓库：`https://github.com/rh17615113812-bit/layer-canvas-studio`

## 1. 项目定位

这是一个本地运行的游戏 UI 图层拆分与画板编辑工具，技术栈为 React、TypeScript、Vite、Konva 和 Node.js。

主要能力：

- 导入普通图片或 PSD。
- 将每张导入图片作为独立画板管理。
- 在画板内编辑图片图层、组和拆分结果。
- 手动框选或 AI 自动识别待拆分区域。
- 使用 Seedream API 或本地 ComfyUI 工作流生成独立素材。
- 导出画板或组的 JSON、分层 PSD 和 Unity 包。

项目数据会自动保存到当前浏览器的 IndexedDB；刷新页面会恢复上次的场景、画板、图层、图片数据和视图位置。浏览器存储空间不足或被清除时无法恢复。顶部“清除保存”会在确认后删除本浏览器保存的工作区，不会删除已导出的文件。

## 2. 启动与检查

安装依赖后，在项目目录运行：

```powershell
npm run dev -- --host 127.0.0.1
```

服务：

- 前端：`http://127.0.0.1:5173/`
- 本地 API 代理：`http://127.0.0.1:8787/`
- ComfyUI 默认地址：`http://127.0.0.1:8188/`

也可以分别启动：

```powershell
npm run api
npx vite --host 127.0.0.1
```

常用检查：

```powershell
npm run check
npm test
node --check server.mjs
npm run build
```

交接时上述检查全部通过。生产构建只有现有主 JS chunk 超过 500 kB 的 Vite 警告。

生成本文档时确认 `127.0.0.1:8787` 正在监听；未检测到 `8188` 上的 ComfyUI 服务。前端页面仍在应用内浏览器中打开，但新会话应重新确认 `5173` 端口。

## 3. 本地配置

复制 `.env.example` 为 `.env.local`，不要提交 `.env.local`：

```text
ARK_API_KEY=本机方舟_API_Key
ARK_SEEDREAM_MODEL=doubao-seedream-5.0-pro
ARK_VISION_MODEL=doubao-seed-2-0-lite-260215

COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_WORKFLOW_FILE=
```

注意：

- API Key 只存放在本机服务端环境变量中，不能写入前端、Git、日志或交接文档。
- `COMFYUI_WORKFLOW_FILE` 可留空，改为在“本地拆分”TAB 中选择工作流 JSON。
- ComfyUI 工作流必须使用 `Save (API Format)` 导出的 API 工作流，而不是包含 `nodes` 数组的界面工作流。

## 4. 当前数据模型

核心类型位于 `src/types.ts`：

- `DocumentState`：画布、画板和全部图层。
- `Artboard`：画板工作区坐标与尺寸。
- `LayerNode`：图片、组或选区；图层坐标仍使用工作区坐标。
- `artboardId`：图层所属画板。
- `parentId`：组内父子关系。
- `boundsMode: "manual"`：表示组框尺寸已经与子元素内容边界解耦。

坐标约定：

- 编辑状态使用工作区绝对坐标。
- 导出画板时减去画板原点。
- 导出组时减去组框原点。
- 组框不会裁切子元素；画板仍会裁切画板外内容。

相关文件：

- `src/artboards.ts`：画板移动、缩放、归属判断和导出坐标归一化。
- `src/coordinates.ts`：原图像素与 `0–999` 归一化框换算。
- `src/layerOrder.ts`：Ctrl/Shift 多选、批量层级移动和跨画板归属。

## 5. 画板与组

### 画板

- 每张导入图片会创建一个独立画板。
- 点击画板标题拖动整个画板及其内容。
- 选中画板后可以使用控制点调整尺寸；调整画板不会缩放内部素材。
- 图片完全拖出画板后会成为“画板外”素材。
- 图层可以从左侧树拖入任意画板或移到画板外。
- JSON、PSD 和 Unity 导出均以画板为单位。

### 组

- 画板内素材可以编组。
- 组可以存在于画板内，也可以位于画板外。
- 组左上角显示名称标题；拖动标题会移动组框和所有后代素材。
- 组框可以自由调整尺寸，不会缩放组内素材。
- 素材超出组框后仍完整显示，不会被组裁切。
- 组框本身不参与鼠标命中，因此不会阻挡组内素材或画板控制点。
- 选中组导出时，以组框尺寸作为输出画布；框外内容会在最终文件边界处被裁切。

## 6. 图层面板交互

- 点击单层：单选。
- `Ctrl + 左键`：加选或减选图层。
- `Shift + 左键`：按当前可见图层顺序连续选择。
- `Delete` / `Backspace`：删除当前选中图层或多选图层；删除组时会一并删除其所有后代图层。在输入框、文本框和拆分工作区中不会触发，避免误删编辑内容。
- 拖动多选中的任意图层：整体移动层级位置，并保持相对顺序。
- 拖动目标使用两层之间的绿色横线表示插入位置。
- 组和子层同时被选中时只移动最外层，避免产生父子循环。
- 跨画板移动组时，其后代图层的画板归属会同步更新。
- 图层树内容过长时支持纵向滚动。
- 锁定按钮点击区域为 `28 × 28px`，使用 `18 × 18px` SVG 图标。

## 7. 拆分入口

选中图片图层，在右侧“AI”页点击“配置拆分”，打开全屏拆分工作区。

工作区包含两个相互独立的 TAB：

1. `API 拆分`
2. `本地拆分`

两者共享框选编辑器，但使用不同的生成与回填规则。本地拆分实现没有修改原有 Seedream API 解析逻辑。

### 7.1 共享框选能力

- 鼠标手动绘制框。
- 移动和八方向缩放框。
- 删除、撤销、重做。
- 可编辑自动识别提示词并恢复默认。
- AI 自动识别框选。
- 第二步编辑名称、类型和是否拆分。
- `text` 类型固定不送入拆分；只有 `ui && shouldSplit !== false` 的框会执行生成。

AI 自动框选当前仍调用 `/api/vision/boxes`，使用方舟视觉模型返回语义、框和置信度。它只是两套拆分入口共用的定位服务，不参与 ComfyUI 图片生成。

## 8. API 拆分

主要文件：

- `src/seedream.ts`
- `src/smartSplit.ts`
- `src/SmartSplitWorkspace.tsx`
- `src/App.tsx`
- `server.mjs`

接口：

- `POST /api/vision/boxes`
- `POST /api/seedream/layer-split`

行为：

- 未框选时可以直接让 Seedream 5.0 Pro 自动拆分。
- 有框选时，前端将原图像素框转换为 `0–999` `<bbox>` 提示词。
- 官方返回的 `bounding_box`、基础输出尺寸和原图尺寸共同决定最终位置。
- PNG 原始像素完整保留；显示位置与尺寸映射回输入图片坐标系。
- `z_index === 0` 作为拆分底图，其余为透明图层。
- API 返回的名称、坐标和层级继续沿用原有处理方式。

不要自动重试状态不明或可能产生费用的 API 请求。失败后应显示错误，让用户明确决定是否重新提交。

## 9. 本地 ComfyUI 拆分

主要文件：

- `src/localComfy.ts`
- `src/SmartSplitWorkspace.tsx`
- `src/App.tsx`
- `server.mjs`

接口：

- `POST /api/comfyui/layer-split`

前端配置：

- ComfyUI 地址，默认 `http://127.0.0.1:8188`。
- API 工作流 JSON 文件。
- 可选输入节点 ID。
- 可选输出节点 ID，多个 ID 使用英文逗号分隔。

自动节点规则：

- 未填写输入节点时，自动查找第一个 `class_type` 包含 `LoadImage` 的节点。
- 未填写输出节点时，收集工作流历史中的所有图片输出。
- 工作流若有多个中间图片输出，建议显式填写最终输出节点 ID。

执行流程：

1. 必须先手动框选或 AI 自动框选，因为本地模型不返回坐标。
2. 每个可拆分 UI 框从原图独立裁切。
3. 每个裁切图依次上传到 ComfyUI `/upload/image`。
4. 服务端把上传文件名写入 `LoadImage.inputs.image`。
5. 调用 `/prompt` 排队。
6. 轮询 `/history/{prompt_id}`，不重复提交任务。
7. 从 `/view` 读取输出图片并返回前端。
8. 前端忽略模型坐标，只使用原框定位。
9. 若输出图片整体变大，按原框执行等比 `contain` 缩放并在框内居中。
10. 再根据源图片图层当前显示尺寸映射到画板工作区坐标。

本地接口只允许访问 `localhost`、`127.0.0.1` 或 `::1`，防止配置被误用为远程任意代理。

当前状态：

- TAB、配置表单、手动框选、服务端路由和回填算法已完成。
- API 代理已重启，新路由已生效。
- 未检测到 `8188` 上的 ComfyUI，也没有用户工作流文件，因此真实 ComfyUI 推理尚未验收。
- 已验证在缺少工作流时返回明确错误：要求选择 API 工作流 JSON 或配置 `COMFYUI_WORKFLOW_FILE`。

## 10. PSD 导入与导出

### PSD 导入

- `src/psdImport.ts` 负责读取 PSD 图层并创建画板/图层。
- 当前导入内容可继续参与画板、组、排序和拆分操作。

### PSD 导出

- `src/exports.ts` 使用 `ag-psd` 写入分层 PSD。
- 图片图层写入显示尺寸的 raster preview。
- 原始 PNG 同时作为 Photoshop Smart Object linked file 嵌入。
- 导出画板或组时均使用归一化后的局部坐标。
- 根级 composite image 会按可见性、组透明度、图层透明度、旋转和层级顺序合成。
- 同时写入带棋盘背景的标准 PSD thumbnail，Windows 资源管理器不再显示纯黑缩略图。
- 组框可能包含小数尺寸；导出 PSD 时统一取整数像素，避免文档与 Canvas 尺寸不匹配。

旧的黑色 PSD 不会自动修复，需要重新导出。资源管理器仍显示缓存时，可刷新文件夹或使用新文件名。

## 11. 导出格式

- `导出画板 JSON` / `导出组 JSON`
- `导出画板 PSD` / `导出组 PSD`
- `画板 Unity 包` / `组 Unity 包`

组导出规则：

- 输出宽高等于当前组框宽高。
- 子图层坐标减去组框原点。
- 允许负坐标；超出组框的内容在文件边界处裁切。

## 12. 当前验证结果

已通过：

```powershell
npm run check
npm test
node --check server.mjs
npm run build
```

测试覆盖：

- 像素框和归一化框换算。
- Seedream 合成位置。
- 画板坐标、移动、缩放、归属和导出。
- 组导出坐标。
- 跨画板命中。
- Ctrl/Shift 选择与多层排序。
- 组和子层的安全移动。
- 本地 ComfyUI 输出按原框等比 contain 回填。

实际页面已验证：

- 组内素材可以单独选择和拖动。
- 组框不会阻挡画板尺寸控制点。
- API 拆分与本地拆分 TAB 正常切换。
- 本地拆分配置表单正常显示。
- 本地模式可以手动创建框，创建后“下一步”可用。
- `/api/comfyui/layer-split` 与原 `/api/vision/boxes` 路由同时生效。

尚未验证：

- 用户实际 ComfyUI 工作流的完整推理输出。
- 不同工作流自定义节点对输入/输出自动识别的兼容性。
- Photoshop CC 2020 中新导出 PSD 的最终人工打开验收。
- Windows 资源管理器对新 PSD 缩略图的实际缓存刷新结果。

## 13. 关键文件

```text
server.mjs                    方舟代理、视觉框选、ComfyUI 工作流代理
dev.mjs                       同时启动 Node 代理和 Vite
src/App.tsx                   主编辑器、画板、组、选择、拆分接入
src/SmartSplitWorkspace.tsx   框选工作区与 API/本地 TAB
src/seedream.ts               Seedream 响应解析和官方坐标还原
src/localComfy.ts             本地裁切、请求、等比回填
src/smartSplit.ts             默认识别提示词和可拆分框过滤
src/coordinates.ts            bbox 坐标换算
src/artboards.ts              画板与组导出坐标
src/layerOrder.ts             图层多选与批量排序
src/exports.ts                JSON、PSD、Unity 导出
src/psdImport.ts              PSD 导入
src/types.ts                  核心数据结构
src/style.css                 主界面和拆分工作区样式
tests/coordinates.test.ts     当前无框架测试入口
```

## 14. Git 状态

当前工作树包含大量未提交改动和新增文件，属于本项目连续开发结果，不要执行 `git reset --hard` 或覆盖式回退。

当前状态概览：

```text
修改：.env.example、package.json、server.mjs、src/App.tsx、
      src/SmartSplitWorkspace.tsx、src/exports.ts、src/main.tsx、
      src/psdImport.ts、src/seedream.ts、src/style.css、src/types.ts

新增：dev.mjs、handsff.md、src/artboards.css、src/artboards.ts、
      src/coordinates.ts、src/layerOrder.ts、src/localComfy.ts、
      src/smartSplit.ts、tests/
```

提交前重新执行：

```powershell
git status --short
npm run check
npm test
node --check server.mjs
npm run build
```

## 15. 建议的下一步

1. 启动用户的 ComfyUI，确认 `http://127.0.0.1:8188` 可访问。
2. 从 ComfyUI 导出一份 `Save (API Format)` 工作流。
3. 在“本地拆分”中选择该 JSON，先只框选一个元素。
4. 如工作流存在多个图片输出，填写最终 `SaveImage` 或 `PreviewImage` 节点 ID。
5. 验证输出是否按原框等比缩放、居中并回到正确画板位置。
6. 用 Photoshop CC 2020 打开新导出的画板 PSD 和组 PSD，检查图层、Smart Object、画布尺寸和透明度。
7. 在 Windows 资源管理器中确认新文件缩略图包含画面内容。
8. 如需跨浏览器或跨设备转移工作区，再增加项目文件导入/导出功能；当前自动保存仅限本机当前浏览器。

## 16. 交接原则

- 保持 API 拆分与本地拆分两套规则独立。
- 不要把本地 ComfyUI 的无坐标输出送入 Seedream 的 `bounding_box` 还原逻辑。
- 本地输出始终以原框为位置真源，并执行等比缩放适配。
- 不要把程序文字静默栅格拆分为图片层。
- 不要自动重试可能产生费用或状态不明的远程 API 请求。
- 不要提交任何 API Key、个人路径下的秘密配置或用户素材。
- 技术检查通过不等于真实模型、Photoshop 或用户验收通过；交接时必须明确区分。
