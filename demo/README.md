# demo —— 原理 + 能力 + 实测演示片

产物：

| 文件 | 说明 |
|---|---|
| `storyboard.md` | 分镜（15 屏 / 140 秒：原理 6 + 能力 2 + 实测 6 + 收尾 1） |
| `content.json` | 画面文案（UTF-8；脚本保持 ASCII） |
| `render.ps1` | 一键渲染：真跑证据链 → GDI+ 画帧 → ffmpeg 合成 |
| `live/*.mjs` | 复现 / 修复 / 补 AI 回复 / 全量校验 / 采集 |
| `captured/*.txt` | 每次运行留下的**真实 stdout**（已脱敏；画面终端输出就是它） |
| `demo.mp4` | 成片：1920x1080 / 30fps / H.264 / yuv420p / 140 秒 |
| `frames/` `clips/` `live/scratch/` | 中间产物，可删（已在 `.gitignore` 忽略） |

## 依赖

- Windows + **Windows PowerShell 5.1 或 PowerShell 7**（只用 GDI+，无第三方模块）
- **Node 24**（`node:zlib` zstd / `node:sqlite`）
- **ffmpeg**（`ffmpeg.exe`；`ffprobe.exe` 可选，仅最后报告用）
- **DSH 安装**：实测段要调真实加载器 `dsh headless`
- 字体：Microsoft YaHei UI、Consolas（Windows 自带）

## 重跑渲染

```powershell
# -DshCli 指向 dsh 启动器；ffmpeg 不在 PATH 时再加 -FfmpegDir
powershell -ExecutionPolicy Bypass -File demo/render.ps1 -DshCli "<DSH_INSTALL>/resources/runtime/cli/bin/dsh.cmd" -FfmpegDir "<ffmpeg bin dir>"

# 也可以走环境变量 DSH_CLI
pwsh -File demo/render.ps1
```

可选开关：`-SkipCapture`（复用 `captured/*.txt`）、`-SkipVideo`（只画 `frames/*.png`）、`-Fps`。
只改文案/加屏时用 `-SkipCapture` 重渲染即可（实测证据不变）。

render.ps1 做的事：

1. `node live/capture.mjs --dsh <cli>` —— 现场跑 10 条命令（见下），stdout 脱敏后写入 `captured/*.txt`
2. GDI+ 把 `content.json` + `captured/*.txt` 画成 15 张 1920x1080 PNG
3. 每张图编码成带 0.4s 淡入淡出的 H.264 片段，再无损拼接为 `demo.mp4`
4. ffprobe 报告时长/分辨率；被宿主策略禁用时退回 `ffmpeg -i`

## 实测证据链（capture.mjs）

```powershell
cd demo
node live/capture.mjs --dsh "<dsh launcher>"
```

| 步骤 | 做什么 | 期望 |
|---|---|---|
| 01-fixture | 造 9 条旧布局会话（8 条多轮每轮写 turn/start{turn:1}） | exit 0 |
| 02-validate-legacy | 真实 `dsh headless` 逐条校验 | exit 1，**8 FAIL / 1 PASS**，报 turn/start does not open the expected turn |
| 03-repair | 逐轮配对 turn/start → turn/end（turn 1..N）、重排 seq、重新分帧 | exit 0 |
| 04-validate-fixed | 复查 | exit 0，**9/9 PASS** |
| 05-assistant | 用 `scripts/build-dsh-session.mjs` 重建，补 assistant/message + 4 段 stream | exit 0 |
| 06-validate-assistant | 复查 | exit 0，**9/9 PASS** |
| 07-selftest | `scripts/selftest.mjs` 全链路 | exit 0，**19/19** |
| 08-cache | 生成 version-7 投影缓存 | exit 0 |
| 09-verify | `verify-dsh-session.mjs --require-cache --run-dsh` | exit 0，**11 checks PASS** |
| 10-privacy | `node privacy-scan.mjs .` | **hits: 0** |

单独使用某个环节：

```powershell
node live/legacy-fixture.mjs --home <tmp home> --ws <tmp workspace>
node live/validate-all.mjs  --home <tmp home> --dsh "<dsh>" [--quiet]
node live/repair-turns.mjs  --home <tmp home>
node live/rebuild-with-assistant.mjs --home <tmp home>
```

## 脱敏规则（capture.mjs 内置）

捕获到的真实输出在写盘与画帧之前统一替换：

| 原始 | 占位符 |
|---|---|
| 用户目录与用户名（`C:\Users\<name>…`） | `<workspace>` |
| OS 临时目录（`…\Temp\dsh-…`） | `<tmp>` |
| DSH 启动器路径 | `<cli>` |
| 其它绝对路径 | `<path>` |
| 真实会话 id（非全零 demo uuid） | `session-<id>` |

fixture 会话 id 用全零 demo uuid（`session-00000000-0000-4000-8000-00000000000N`），
因此既明显是合成数据，也不会触发 `privacy-scan.mjs` 的「疑似真实会话 id」规则。

## 校验成片

```powershell
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate,pix_fmt -show_entries format=duration,size -of default=noprint_wrappers=1 demo/demo.mp4
```

期望：`h264` / `1920x1080` / `30 fps` / `yuv420p` / `duration ≈ 140`。

## 隐私

- 画面与仓库文本中没有真实用户名、用户绝对路径、真实会话 id 或密钥。
- fixture 正文全部为合成示例；校验使用真实 DSH 加载器，但对象是临时目录里的合成会话。
- `render.ps1` 源码保持纯 ASCII，所有中文从 UTF-8 的 `content.json` / `captured/*.txt` 读入。
