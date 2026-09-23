# 续接 Brief

## 目标与当前进度

继续维护本地 React、TypeScript、Vite、Konva 图层拆分工具。最近完成的需求：重叠框默认按面积排序，面积小的在上、面积大的在下；下层框只把被上层框覆盖的交集涂黑。重叠框自动成组，组内可拖拽排序。AI 框和新建框默认按面积排；用户手动调序后保留手动顺序。RunningHub / 本地 ComfyUI 返回图层继续使用遮罩与层级顺序。

## 关键状态

- 当前分支 `main`，HEAD `e7521b6 fix: refine smart split interactions`；有未提交修改，勿重置或覆盖。修改文件：`handsff.md`、`src/App.tsx`、`src/SmartSplitWorkspace.tsx`、`src/coordinates.ts`、`src/exports.ts`、`src/localComfy.ts`、`src/runningHub.ts`、`src/style.css`、`src/types.ts`、`tests/coordinates.test.ts`；未跟踪 `src/boxOverlap.ts`。尚无本次提交。
- `npm run check`、`npm test` 通过；`npm run build` 的默认 Vite 配置加载遇到 esbuild “Access is denied”；`npx vite build --configLoader runner` 通过，只有 JS chunk 约 920 KB 的体积警告。
- 程序文字已有图层数据、编辑样式、坐标归一化和 PSD/Unity/Cocos 导出；OCR 实际识别还未接入。上次尝试连接火山视觉服务被自动审批拒绝，因为会上传框选图片；未发送图片。继续前需用户明确授权该外传，或改用本地 OCR 方案。
- `handsff.md` 是 9 月 23 日的旧交接，现有改动且内容可能过时；其中记载 RunningHub 错误 803、节点 470 字段名 `LoadImage`，需重新核实，勿自动重提可能计费的任务。

## 新会话下一步

先在项目目录查看 `git status --short`、`git diff`、未跟踪文件和本 Brief，再按用户最新指令继续。不要读取或暴露 `.env.local`。面积排序/遮罩实现与测试主要在 `src/boxOverlap.ts`、`src/SmartSplitWorkspace.tsx`、`src/runningHub.ts`、`src/localComfy.ts` 和 `tests/coordinates.test.ts`。
