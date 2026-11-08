# Captain · 队长

一个自托管的 **多 Agent 团队编排平台**：

- 后台网页里固定一个「主管」agent，API / 模型由你自己填写
- 动态添加不同分工的员工 agent：文本、编程、生图、语音、视频……
- 每个员工绑定自己的 API、模型、标签
- 主管按标签拆解任务、并行派活、验收、只把最终结果回给你
- 入口支持 **QQ（NapCat）、Telegram、飞书**
- 员工产物（图片、音频、文件）会真实回传到聊天

> 当前版本是 MVP：核心闭环已打通，编程员工的「隔离执行 runner」在下一阶段接入。详见「当前进度」。

---

## 架构

```text
QQ / Telegram / 飞书
        │
        ▼
captain（Node 22 + 原生 HTML 后台）
├─ 通道适配 + 用户/群/老板白名单
├─ 团队/标签/API Key 加密管理
├─ 原生编排器：主管拆解 DAG → 并行派活 → 验收 → 汇报
├─ 员工执行器：LLM / 生图 / TTS
└─ Hermes 客户端（可选）
        │
        ├─ Hermes Agent（可选，Kanban / 工具 / 编程运行时）
        └─ NapCat（QQ 协议端）
```

- 后台端口：`8080`
- 数据目录：`/data`（`config.json`、日志、任务、产物、加密主密钥）
- 默认所有容器非 root、只读根文件系统、`cap_drop: ALL`

---

## 当前进度

### 已实现

- [x] Docker 化 Node 22 后台，原生 HTML + fetch，单页管理界面
- [x] 后台登录：scrypt 密码 + HttpOnly Cookie + 登录限流
- [x] 首次启动随机生成 16 位密码，打印到容器日志
- [x] 主管单例：API / base_url / 模型 / 提示词 / 标签可配置
- [x] 员工 CRUD：执行类型、provider、API Key、模型、标签、提示词、启用/停用
- [x] API Key 加密存储（AES-256-GCM），页面/导出默认打码
- [x] 聊天里直接发 API Key：进入模型前拦截、加密、日志脱敏
- [x] 聊天创建员工 / 删除员工二次确认
- [x] 原生编排器：主管拆 JSON DAG → 并行执行 → 逐项验收 → 汇总汇报
- [x] 员工执行器：OpenAI 兼容 / Anthropic / 豆包 Ark 生图 / 火山 TTS / edge-tts
- [x] 任务记录：拆解、每个员工状态、验收结果、产物、耗时
- [x] QQ：NapCat / OneBot v11 WebSocket，实际 QQ 登录（NapCat WebUI 扫码/账号密码）
- [x] QQ 白名单：用户、群、老板；群聊必须 @机器人
- [x] Telegram：Bot API 长轮询，私聊/群聊 @，白名单
- [x] 飞书：官方长连接，私聊/群聊 @，白名单
- [x] Hermes 集成：Chat API + Dashboard Profile/Env 同步（可选）
- [x] Docker Compose：captain + 可选 hermes / napcat
- [x] 本地 mock 测试与语法检查

### 下一阶段

- [ ] 编程员工的隔离 runner（Docker 工作区、命令执行、测试、浏览器验收）
- [ ] Kanban 任务板在后台完整展示（Hermes 模式）
- [ ] 生图/语音员工的流式进度与重试策略
- [ ] 预算/并发/每日消费上限的硬限制
- [ ] 微信通道（个人微信建议走 OpenClaw/ClawBot，企业微信走官方接口）
- [ ] 验收标准模板与更严格的产物校验

---

## 快速开始

### 1. 准备

- Linux 服务器（建议 2C4G 起）或 Docker Desktop
- Docker 24+ / Docker Compose v2
- 至少一个模型 API Key（DeepSeek / Claude / 豆包 / OpenAI 兼容）
- 可选：QQ 小号、Telegram Bot Token、飞书应用

### 2. 配置

```bash
cp .env.example .env
```

至少修改：

```dotenv
CAPTAIN_MASTER_KEY=换成一串足够长的随机字符串
HERMES_DASHBOARD_SESSION_TOKEN=换成一串至少 32 位的随机字符串
```

> `CAPTAIN_MASTER_KEY` 用于加密 `/data` 里的 API Key。**首次部署前固定，之后不要改**；改了旧密钥无法解密。

### 3. 启动

只启动 Captain 后台：

```bash
docker compose up -d --build
```

需要 QQ：

```bash
docker compose --profile qq up -d
```

需要 Hermes 引擎（可选）：

```bash
docker compose --profile hermes up -d
```

如果你已经有外部 Hermes，只启动 captain，并把 `.env` 里的 `HERMES_BASE_URL`、`HERMES_DASHBOARD_URL` 指过去即可。

### 4. 登录后台

```bash
docker logs captain 2>&1 | grep "初始后台密码"
```

打开 `http://服务器IP:8080`，用日志里的初始密码登录，然后到「运维」修改密码。

### 5. 配置主管

「主管」页填写：

- Provider：OpenAI 兼容 / Anthropic / 豆包
- Base URL：例如 `https://api.deepseek.com`
- 模型：例如 `deepseek-chat`
- API Key
- 标签：默认 `调度,验收`，**不要**给主管打生图/语音标签

保存后点「测试连接」。

### 6. 添加员工

「团队 → 新增员工」：

| 字段 | 说明 |
|---|---|
| 执行类型 | `llm` 文本 / `code` 编程 / `image` 生图 / `tts` 语音 / `asr` / `video` |
| Provider | `openai-compatible` / `anthropic` / `doubao` / `volc-tts` / `edge-tts` / `pollinations` |
| Base URL | 各家 API 地址 |
| 模型 | 例如 `doubao-seedream`、`claude-sonnet-5`、`deepseek-chat` |
| 标签 | 例如 `生图,海报`；主管按标签派活 |
| API Key | 加密保存，页面只显示 `sk-****后四位` |

> 标签必须和执行类型匹配。给 DeepSeek 打「生图」标签，它仍然生不了图；后台会给出警告。

---

## QQ 登录与白名单

### 登录

1. 启动 napcat：

   ```bash
   docker compose --profile qq up -d
   ```

2. 后台「通道 → QQ → 打开 NapCat 登录页」。
3. 在 NapCat 页面扫码，或输入 QQ 账号密码。
4. 登录态保存在 `/data/napcat/QQ`，容器重启不需要重新登录。

> NapCat 是非官方 QQ 协议端，存在风控/封号风险，建议使用专用小号。

### 白名单

| 字段 | 行为 |
|---|---|
| 用户白名单 | 私聊只有名单里的 QQ 能触发 |
| 群白名单 | 只有名单里的群才处理 |
| 老板 QQ | 只有老板能新增/删除员工、改 API Key、改配置 |
| 群内触发 | 固定为 **必须 @机器人**（默认） |

- 不在白名单的消息直接丢弃，不调用任何模型、不消耗 API 费用。
- 群聊里 @机器人 的普通成员可以对话/派活；团队管理只允许老板。

---

## Telegram

1. 在 @BotFather 创建 Bot，拿到 Token。
2. 后台「通道 → Telegram」填 Token。
3. 私聊白名单填你的 Telegram user id；群聊白名单填 chat id。
4. 群聊需要把 Bot 拉进群，并关闭 Privacy Mode 或 @机器人 触发。
5. 保存后自动重启通道。

## 飞书

1. 飞书开放平台创建企业自建应用，开启机器人能力。
2. 获取 App ID / App Secret。
3. 后台「通道 → 飞书」填写，保存。
4. 使用官方长连接，不需要公网回调地址。
5. 用户白名单填 open_id；群白名单填 chat_id。

---

## 聊天里直接加员工

在 QQ / Telegram / 飞书里直接发：

```text
这是豆包的生图 API：sk-xxxx
帮我建一个生图员工，模型 doubao-seedream，标签生图、海报
```

系统会：

1. 在消息进入模型前拦截 Key，加密保存；
2. 主管只看到「已安全接收密钥」；
3. 根据你提供的服务商/模型/标签创建员工；
4. 你也可以用命令精确控制：

```text
/agents
/addagent name=豆包画师 kind=image provider=doubao model=doubao-seedream tags=生图,海报 baseUrl=https://ark.cn-beijing.volces.com/api/v3
/delagent <员工id>
/confirm
/help
```

> 删除员工必须二次确认。聊天平台本身可能留存消息；敏感 Key 建议优先在后台填写。

---

## 原生编排流程

```text
你的一句话
  ↓
主管（你配置的 API/模型）拆解 JSON DAG
  ↓
按 kind + tags 选择员工
  ↓
无依赖任务并行，有依赖任务等待上游
  ↓
产物写入 /data/runs/<runId>/artifacts
  ↓
主管逐项验收，失败任务重做一次
  ↓
主管汇总最终结果
  ↓
文字回传 + 图片/音频/文件作为附件发送
```

编排开关在「主管 → Hermes 引擎」：

- `native`：Node 原生编排，直接调用主管和员工 API（默认）
- `hermes`：全部交给 Hermes Agent
- `auto`：主管没有配置 API Key 时使用 Hermes

---

## 数据与安全

| 路径 | 内容 |
|---|---|
| `/data/config.json` | 业务配置、加密后的 API Key |
| `/data/master.key` | AES 主密钥（文件权限 600） |
| `/data/runs/` | 每次任务、拆解、产物 |
| `/data/logs/` | 按天轮转日志，默认保留 7 天、单文件 5MB |
| `/data/napcat/` | QQ 登录态与 NapCat 数据 |

- API Key 只在服务端解密使用；不会写进日志、不会发给主管模型。
- 后台导出默认打码；「导出（含密钥）」只在可信环境使用。
- 公网部署建议：
  - 只暴露 8080
  - 前面加 Caddy/Nginx + HTTPS
  - 限制来源 IP / VPN
  - 设置强密码
  - 定期备份 `/data`

---

## 本地开发

```bash
npm install
CAPTAIN_DATA_DIR=./.devdata PORT=18080 npm start
```

测试：

```bash
npm test
npm run check
```

本地没有 Docker / ffmpeg 时，QQ/NapCat、edge-tts、Docker 验收需要在目标 Linux 服务器执行。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CAPTAIN_DATA_DIR` | `/data` | 数据目录 |
| `PORT` | `8080` | 后台端口 |
| `CAPTAIN_MASTER_KEY` | 自动生成 | API Key 加密主密钥，生产环境必须固定 |
| `HERMES_BASE_URL` | `http://hermes:8642` | Hermes OpenAI 兼容 API |
| `HERMES_API_KEY` | 空 | Hermes API Server Key |
| `HERMES_DASHBOARD_URL` | `http://hermes:9119` | Hermes Dashboard API |
| `HERMES_DASHBOARD_SESSION_TOKEN` | 空 | Hermes Dashboard 会话令牌 |
| `NAPCAT_WS_URL` | `ws://napcat:3001` | NapCat OneBot WS |
| `NAPCAT_ACCESS_TOKEN` | 空 | NapCat WS Token |
| `NAPCAT_WEBUI_URL` | `http://napcat:6099` | NapCat WebUI（后台代理） |
| `NAPCAT_WEBUI_TOKEN` | 空 | NapCat WebUI Token |

---

## 故障排查

| 现象 | 处理 |
|---|---|
| 打不开 8080 | `docker compose ps`；检查防火墙/安全组；`docker logs captain` |
| 忘记后台密码 | `docker compose exec captain node reset-password.mjs`（下一阶段提供；当前可删除 `/data/config.json` 的 `auth.passwordHash` 后重启） |
| 主管调用失败 | 「主管」页点测试连接；检查 base_url、模型、Key、余额 |
| QQ 离线 | 打开 NapCat 登录页重新扫码；检查 `NAPCAT_WEBUI_TOKEN` 与 `NAPCAT_ACCESS_TOKEN` |
| NapCat 登录页打不开 | 后台的 `/napcat/` 代理对部分 WebUI 版本可能不完整；用 SSH 隧道兜底：`ssh -L 6099:127.0.0.1:6099 user@服务器`，再打开 `http://127.0.0.1:6099` |
| 群聊不回复 | 检查群白名单；群内必须 @机器人 |
| 图片/语音发不出 | 检查员工 API、模型名、余额；查看 `/data/logs/core.log` |
| 修改配置不生效 | 保存后会自动重载通道；必要时重启 captain |

---

## 安全与边界

- 这是自托管工具，不是多租户 SaaS。
- 主管/员工的 API 费用由你承担；并行任务会放大费用，建议先设小并发。
- 编程员工的「真实执行」需要隔离 runner；当前 MVP 的 code 员工只产出代码文本，下一阶段接入 runner。
- 微信个人号没有官方开放协议，建议后续走 OpenClaw/ClawBot 或企业微信。
