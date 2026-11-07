# local-opencode

把**本机 opencode 已经配好的免费模型**接进 DeepSeek Harness（dsh），让 dsh 的模型选择器里能直接选它们对话。

## 它解决什么

opencode 登录后（本机实测：它自带的匿名推理通道）会有一批 `cost.input/output` 全为 0 的模型，例如 Big Pickle、
DeepSeek V4.1 Flash Free、GLM-5.3-Flash Free、MiMo-V2.6-Flash Free 等。这些模型原本只能在 opencode 里用；
装上本插件后，它们以 `Local OpenCode` 分组出现在 dsh 的选择器里。

**为什么必须绕道本机 opencode**：匿名免费额度绑定在 opencode 的会话身份上。实测直接打上游
`https://opencode.ai/inference/openai/v1` 一律 `429 FreeUsageLimitError`，部分模型还叠加区域封锁；而经本机
opencode 服务（它自带会话身份与归属头）同一批模型能正常出字。所以插件不自己连上游，而是复用本机服务。

## 工作方式

- **发现服务**：读 `~/.local/state/opencode/service.json`（`{ url, pid, password }`）拿地址与口令，再用
  `GET /api/info` 证明它确实活着。手动覆盖：`OPENCODE_SERVER_URL` / `OPENCODE_SERVER_PASSWORD`。
- **模型目录**：`GET /api/model`。零成本且启用的进 `local-opencode` 组；有计费的默认进
  `local-opencode-paid`（空组会被 GUI 丢掉，所以默认只看到免费模型），用 `includePaid` 打开。
- **一次调用**：`POST /api/session` → `POST /api/session/{id}/model` → `POST /api/session/{id}/generate`
  → `DELETE /api/session/{id}`。会话是 per-call 的：这条通道不累积历史（实测第二次问就不记得第一次），
  所以 dsh 每轮重放全量历史；用完即删，也不污染你的 opencode 会话列表。
- **思考档位**：内核的 reasoning effort 直接映射成 opencode 的 `variant`（`low/high/max` 等）。目录里有
  哪些档位就暴露哪些；不支持的档位本地拦下并说明可用值。

## 已知限制（重要）

这条通道是**无函数的纯文本通道**：dsh 的工具声明不会传给模型（历史压平成文本，并附一句当前通道不支持
工具的说明）。因此在 dsh 里它适合问答、写作、分析，不适合作为能改代码的 agent。换来的好处是零副作用：
不碰你的文件、不读你的凭据、不产生 opencode 侧的写操作。

匿名通道有额度与地区限制（本机实测 10 个免费模型中 8 个可用，2 个被区域拒绝）。这类失败会在对话里以明确
原因结束（区域限制 / 额度墙 + provider 要求的退避时长），不会静默吞掉，也不会反复重试烧额度。

## 安装

已在本机装好（web profile）。手动安装：

```powershell
dsh plugin --profile web add link:C:/Users/HP/.dsh/local-opencode
# 然后重启 dsh
```

配置写在 `~/.dsh/local-opencode/settings.json`（也可由 bundle 的 `config` 覆盖）：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 关掉则不注册任何路由（模型从选择器消失） |
| `includePaid.githubCopilot` / `.others` | `false` | 是否列出对应渠道的计费模型 |
| `refreshMinutes` | `30` | 后台刷新目录的间隔，0 = 只在启动/手动刷新时拉 |
| `requestTimeoutMs` | `180000` | 单次上游请求超时 |

状态接口（组合里有 web 服务时）：`GET /api/local-opencode/status`、`POST /api/local-opencode/refresh`、
`POST /api/local-opencode/test`（真发一轮最小请求，用来确认选了就能用）。这些路由自带与内核同级的准入围栏。

## 测试

```powershell
node test/mock-runtime.mjs   # 43 项断言：假 cordis + 假 opencode，覆盖内核对适配器的每一项硬校验
node test/live.mjs           # 真机验收：本机 opencode 的每个免费模型各跑一轮
node test/live.mjs --quick   # 只跑前 3 个
```

契约测试断言的内容都来自 `@deepseek-ai/dsh-llm` 的实现：`registerAdapter` 会逐个路由调用
`providerInfo` / `providerRetryPolicy`（退避字段必须在顶层）；`prepareCall` 被 await 后其 `.model` 受
`normalizeModelInfo` 同步校验——`id` 必须等于传入的 model、name 非空、contextWindow 为正整数、efforts 非空
且 id 唯一。少写一个 `await` 就会把 Promise 交给校验并报 `INVALID_MODEL_INFO`（真机踩过，已固化成断言）。
流必须严格是 `block-start → text-delta → block-end → usage → finish`。

## 前提

本机装有 opencode（`npm i -g @opencode/cli`）并已登录至少一个渠道；`~/.local/state/opencode/service.json`
由它自己生成（TUI 或 `opencode serve` 在跑时就有）。
