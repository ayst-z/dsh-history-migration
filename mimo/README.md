# 给 DSH 添加 MiMo 提供商

把小米 MiMo（MiMo Studio / xiaomimimo-for-copilot 所用的同一套 API）接进 DSH 的模型选择器。**API 密钥留空**，需要时再填。

## 事实依据

| 项 | 值 | 来源 |
|---|---|---|
| 基础地址（默认） | `https://api.xiaomimimo.com/v1` | VS Code 扩展 `sdmapvstool.xiaomimimo-for-copilot` 的默认 `baseUrl` |
| 备用地址 | `https://token-plan-cn.xiaomimimo.com/v1` / `-sgp` / `-ams` | 同上 |
| 协议 | OpenAI Chat Completions（`/v1`） | 同上 |
| 模型 id | `mimo-v2.6-flash`、`mimo-v2.6-pro`、`mimo-v2.6-pro-ultraspeed` | 扩展的 `mimo-copilot.modelIdOverrides` |

## 落点

DSH 的第三方提供商配置在 **`$DSH_HOME/profiles/<profile>/cordis.patch.yml`** 的 `llm-pi-ai` 条目里（`@deepseek-ai/dsh-llm-pi-ai`）。本目录的 `cordis.patch.yml` 就是可直接并入的顶层条目：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      mimo:
        displayName: MiMo
        api: openai-completions
        baseURL: https://api.xiaomimimo.com/v1
        apiKeyEnv: MIMO_API_KEY      # ← 密钥引用名，值尚未提供
        models:
          - id: mimo-v2.6-flash
          - id: mimo-v2.6-pro
          - id: mimo-v2.6-pro-ultraspeed
```

## 应用

```powershell
# 1) 先落到 web profile 并用 dump-config 校验（可跑通）
./apply-mimo-provider.ps1

# 2) 再追加到正在使用的 desktop profile（Electron 独占，无法 dump-config 校验）
./apply-to-desktop.ps1
```

两个脚本都会先备份成 `cordis.patch.yml.bak-mimo-20260930`；回退就是把备份复制回去。

## 密钥

`apiKeyEnv: MIMO_API_KEY` 只是**凭据引用名**，不是密钥本身，写进仓库是安全的。填密钥的两条路：

1. **环境变量**：设置 `MIMO_API_KEY` 后重启 DSH；
2. **设置 → 模型**：在 MiMo 卡片里填写（DSH 会写进 `$DSH_HOME/.credentials.yaml`，该文件**永远不要**提交或上传）。

密钥未填时，模型仍会出现在选择器里，发请求会得到明确的缺凭据错误。

## 验证记录

- `dsh --profile web --dump-config` → `exit=0`，合成树里出现上面的 `mimo` 段（patch 结构与 schema 均被接受）。
- `desktop` profile：顶层条目由 10 增至 11，`cordis.patch.yml` 1955 → 2410 字节，备份保留。
- ⚠️ `desktop` 由 Electron 独占，CLI 不能 `--dump-config`，因此对它的校验只到「文件级」；若 DSH 启动时报配置错误，用备份回退。
