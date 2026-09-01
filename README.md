# WhatsApp Service

一个基于 Baileys 的轻量 WhatsApp Web 服务：负责 QR 配对、保持连接，并通过 HTTP webhook 发 WhatsApp 文本消息。

服务本身不运行 Pi。启用 Pi TUI extension 后，WhatsApp 入站消息会注入同一个 Pi session，Pi 的每条 assistant 回复则同时显示在 TUI 并镜像到 WhatsApp。

## 要求

- Node.js 20+
- npm
- 一个可以绑定新设备的 WhatsApp 账号

## 启动

```bash
npm install
cp .env.example .env
```

编辑 `.env`，至少修改 `WEBHOOK_TOKEN`：

```dotenv
WEBHOOK_TOKEN=replace-with-a-long-random-token
WHATSAPP_HOST=127.0.0.1
WHATSAPP_PORT=3091
SESSION_DIR=./session
```

首次运行需要扫码配对：

```bash
npm run pair
open pairing/latest-qr.html       # macOS；其他系统直接打开该 HTML 文件
```

配对命令会生成 `pairing/latest-qr.html` 和 `pairing/latest-qr.png`，并在终端打印 PNG 的 `file://` 链接。点击链接打开图片后，用 WhatsApp 扫描 QR；QR 会定期更换，请保持命令运行。

在 WhatsApp 中选择 `设置 -> 已连接的设备 -> 连接设备` 扫码。配对成功后启动服务：

```bash
npm start
```

服务会在后台保持 WhatsApp 连接，认证信息保存在 `SESSION_DIR`。以后直接 `npm start` 即可，不需要重复扫码。

## HTTP API

健康检查不需要 token：

```bash
curl http://127.0.0.1:3091/health
```

发送消息：

```bash
curl -X POST http://127.0.0.1:3091/webhook \
  -H 'Authorization: Bearer replace-with-a-long-random-token' \
  -H 'Content-Type: application/json' \
  -d '{"to":"15551234567","message":"来自 pi-coding-agent 的消息"}'
```

请求格式：

```json
{
  "to": "15551234567",
  "message": "hello"
}
```

`to` 可以是带国家码的电话号码（不带 `+` 也可以）或完整 WhatsApp JID，例如 `15551234567@s.whatsapp.net`、群组 JID。`message` 超过 WhatsApp 单条长度时会自动拆分发送。

除了 `Authorization: Bearer ...`，也支持 `X-Webhook-Token` 请求头。`POST /send` 是 `/webhook` 的兼容别名。

也可以使用项目自带的 CLI 调用同一个 webhook：

```bash
npm run send -- \
  --to 15551234567 \
  --message '来自 Pi TUI 的消息'
```

CLI 默认读取 `.env` 中的 `WEBHOOK_TOKEN`、`WHATSAPP_HOST` 和 `WHATSAPP_PORT`。也可以用 `PI_WHATSAPP_WEBHOOK_URL` 指定远程服务地址，用 `PI_WHATSAPP_WEBHOOK_TOKEN` 指定 token。

成功响应：

```json
{
  "ok": true,
  "to": "15551234567@s.whatsapp.net",
  "messageIds": ["..."]
}
```

服务尚未连接时返回 HTTP 503；token 错误返回 401；请求格式错误返回 400。

## 给 pi-coding-agent 使用

推荐让一个 Pi 进程（包括 Pi TUI）拥有自己的 session，并由它调用本服务。不要让 WhatsApp 服务再启动第二个 Pi 进程。

### 自动镜像每条 TUI 回复

先设置 Pi extension 使用的配置：

```bash
export PI_WHATSAPP_WEBHOOK_URL=http://127.0.0.1:3091/webhook
export PI_WHATSAPP_WEBHOOK_TOKEN='replace-with-the-service-token'
export PI_WHATSAPP_TO=15551234567

# 让 WhatsApp 入站消息进入同一个 Pi TUI
export PI_WHATSAPP_INBOUND_TOKEN='replace-with-the-inbound-token'
export PI_WHATSAPP_INBOUND_PORT=3092
```

同时在 WhatsApp 服务的 `.env` 中设置：

```dotenv
WHATSAPP_INBOUND_URL=http://127.0.0.1:3092/whatsapp/inbound
INBOUND_WEBHOOK_TOKEN=replace-with-the-inbound-token
WHATSAPP_INBOUND_ALLOWED_SENDERS=15551234567
WHATSAPP_INBOUND_MODE=bot
```

如果绑定的是自己的号码并从 WhatsApp 自聊窗口输入，改为 `WHATSAPP_INBOUND_MODE=self-chat`，并把自己的号码加入 `WHATSAPP_INBOUND_ALLOWED_SENDERS`。服务发出的回复会自动忽略，不会形成循环。

然后从项目目录启动 Pi：

```bash
pi --extension ./extensions/whatsapp-mirror.mjs
```

启动 extension 后，允许列表中的 WhatsApp 文本会作为 user message 注入当前 TUI；每条完整的 assistant 文本会同时显示在 TUI，并发送到 `PI_WHATSAPP_TO`。镜像请求是异步的；WhatsApp 服务暂时断开时，Pi session 和 TUI 不会被中断，只会显示错误通知。

如果在本项目目录启动，extension 也会尝试读取 `.env`；生产环境仍建议显式使用 `PI_WHATSAPP_*` 环境变量。

Pi TUI 如果可以执行 shell 命令，可以直接调用：

```bash
npm run send -- --to "$PI_WHATSAPP_TO" --message '需要发送的内容'
```

也可以由 agent 直接调用 HTTP webhook：

```bash
curl -sS -X POST "$PI_WHATSAPP_WEBHOOK_URL" \
  -H "Authorization: Bearer $PI_WHATSAPP_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({to: process.argv[1], message: process.argv[2]}))' "$PI_WHATSAPP_TO" "$1")"
```

如果 agent 与服务在同一台机器上，默认地址就是 `http://127.0.0.1:3091/webhook`。建议把 token 放在 agent 的环境变量或 secret store 中，不要写进 prompt、代码仓库或日志。

## 作为系统服务

仓库提供了 macOS launchd 和 Linux systemd 模板。先修改其中的路径和 Node.js 路径，再安装：

- `launchd/com.example.pi-whatsapp.plist`
- `systemd/pi-whatsapp.service`

系统服务需要能够读取项目目录下的 `.env` 和 `SESSION_DIR`。

## 目录

```text
src/pair.mjs       QR 配对并保存 WhatsApp 凭据
src/gateway.mjs    WhatsApp 连接和 HTTP webhook 服务
src/send.mjs       给 Pi TUI / shell 使用的 webhook CLI
extensions/        可选 Pi TUI extension
src/lib.mjs        环境变量、JID 和消息拆分等纯函数
test/lib.test.mjs  单元测试
```

## 检查

```bash
npm run check
npm test
```

## 安全

- 默认只监听 `127.0.0.1`，需要远程访问时请使用 HTTPS 反向代理。
- 必须设置足够随机的 `WEBHOOK_TOKEN`，否则服务不会启动。
- 入站转发必须配置 `WHATSAPP_INBOUND_ALLOWED_SENDERS`，不要直接使用 `*`。
- 不要提交 `.env`、`session/`、`pairing/` 和日志。
- WhatsApp Web 自动化是非官方方案，可能受 WhatsApp 变更影响。

## License

MIT
