# live-screen —— 真机实录（4K60，上采样）

这套脚本在**本机真实运行**迁移流水线，并把**专用控制台窗口**录下来。

## 硬件事实（如实标注）

- 当前桌面 **1536x960 逻辑像素**（主显示器，200% 缩放 → 物理 3072x1920）。
- 录制窗口约 **1200x676 物理像素**；因此母版 3840x2160 **不是原生 4K，而是上采样**。
  母版用 lanczos 放大到 3840x2160@60；仓库版从母版缩到 1920x1080@60（体积 < 90MB）。
- 控制台默认点阵字体为 16px 物理像素：放大后文字清晰度以"可读"为准，不宣称原生 4K。

## 采集方式

- 专用控制台窗口标题固定为 **DSH-MIGRATION-DEMO**；
- ffmpeg **gdigrab 按窗口标题采集**（`-i title=DSH-MIGRATION-DEMO -draw_mouse 0`），不拍整个桌面；
- 控制台窗口只显示 C:\dsh-demo 下的中性路径；真实用户名/安装路径不出现在画面里。

## 文件

| 文件 | 说明 |
|---|---|
| `run-demo.ps1` | 在专用控制台里运行：逐条回显中性命令并真实执行 export → import → build → cache → verify → selftest → privacy |
| `fixtures/vscode-chatSessions/fixture.jsonl` | 合成 VS Code Copilot Chat 会话（供 export-vscode-chat.mjs） |
| `fixtures/mimo-export.md` | 合成 MiMo 网页版导出（供 import-mimo-export.mjs） |
| `../capture-live.ps1` | 控制端：铺 C:\dsh-demo → 启动控制台 → gdigrab 录制 → 编码母版/仓库版 |

## 重跑

```powershell
powershell -ExecutionPolicy Bypass -File demo/capture-live.ps1 -FfmpegDir "<ffmpeg bin>" -DshCli "<dsh launcher>"
```

产物：`demo/demo-4k60.mp4`（母版，`.gitignore` 忽略）、`demo/demo-live.mp4`（仓库版）。

## 隐私

- 演示全部在 `C:\dsh-demo` 下进行；`tools\dsh.cmd` 只是 `"%DSH_CLI%" %*`，真实启动器路径通过环境变量传入，从不出现在屏幕上。
- 运行结束时在画面里执行 `node privacy-scan.mjs C:\dsh-demo`，要求 hits: 0；
  交付前另外在仓库跑 `node privacy-scan.mjs .`，同样要求 0 命中。
