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

功能：导入 PNG/JPG/WebP；无限画布缩放/平移；场景 > Page 的多画布管理；每个 Page 独立保存图层、画布与选中状态；场景右侧可新建 Page；右键 Page 可重命名、创建副本或删除；左侧图层树；选中图片显示可拖拽四角锚点；锁定/解锁宽高比例；选择、移动、缩放、隐藏、锁定、改名；手动选区提取独立 PNG；右侧设计/笔记/AI 属性区；导出当前 Page 的 `layout.json`、分层 PSD、Unity 导入包。

当前“提取选区”是本地无 AI 的基线流程：它从已锁定的原始图层裁切出独立 PNG。后续接入 AI 时，只需将模型返回的 PNG、坐标、名称和层级写入当前 Page 的 `DocumentState.layers` 数组，左侧图层与画布会同步更新。

Unity ZIP 包内含 `layout.json`、透明 PNG 与 `Assets/LayerCanvas/Editor/LayerCanvasImporter.cs`。导入 Unity 后，选中 `layout.json` 并运行 `Tools > Layer Canvas > Import selected layout`。
