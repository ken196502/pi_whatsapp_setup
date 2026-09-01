#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import {
  isAllowedSender,
  loadEnvFile,
  normalizeWhatsAppId,
  parseAllowedSenders,
  splitMessage,
  toWhatsAppJid,
} from "./lib.mjs";

loadEnvFile(path.resolve(".env"));

const proxyUrl = process.env.PI_WHATSAPP_PROXY || process.env.HTTPS_PROXY ||
  process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";

const config = {
  sessionDir: process.env.SESSION_DIR || "./session",
  host: process.env.WHATSAPP_HOST || process.env.HTTP_HOST || "127.0.0.1",
  port: Number.parseInt(process.env.WHATSAPP_PORT || process.env.HTTP_PORT || "3091", 10),
  webhookToken: process.env.WEBHOOK_TOKEN || "",
  messageLimit: Number.parseInt(process.env.WHATSAPP_MESSAGE_LIMIT || "3900", 10),
  inboundWebhookUrl: process.env.WHATSAPP_INBOUND_URL || "",
  inboundWebhookToken: process.env.INBOUND_WEBHOOK_TOKEN || "",
  inboundAllowedSenders: parseAllowedSenders(process.env.WHATSAPP_INBOUND_ALLOWED_SENDERS || ""),
  inboundMode: process.env.WHATSAPP_INBOUND_MODE || "bot",
};

if (!config.webhookToken) {
  throw new Error("WEBHOOK_TOKEN is required");
}
if (!Number.isInteger(config.messageLimit) || config.messageLimit < 1) {
  throw new Error("WHATSAPP_MESSAGE_LIMIT must be a positive integer");
}
if (!["bot", "self-chat"].includes(config.inboundMode)) {
  throw new Error("WHATSAPP_INBOUND_MODE must be bot or self-chat");
}

const startedAt = new Date();
const logger = pino({ level: process.env.WHATSAPP_DEBUG ? "debug" : "warn" });
let sock = null;
let status = "starting";
let sent = 0;
let received = 0;
let lastSentAt = null;
let lastReceivedAt = null;
let forwarded = 0;
let stopping = false;
let reconnectTimer = null;
const seenMessageIds = new Set();
const recentlySentIds = new Set();

function log(level, message, fields = {}) {
  const suffix = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  process.stderr.write(`${new Date().toISOString()} ${level} ${message}${suffix}\n`);
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isAuthorized(req) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const supplied = bearer || String(req.headers["x-webhook-token"] || "");
  return supplied === config.webhookToken;
}

function readJson(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new Error("request body is too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getMessageContent(msg) {
  const content = msg?.message || {};
  if (content.ephemeralMessage?.message) return content.ephemeralMessage.message;
  if (content.viewOnceMessage?.message) return content.viewOnceMessage.message;
  if (content.viewOnceMessageV2?.message) return content.viewOnceMessageV2.message;
  return content;
}

function getText(msg) {
  const content = getMessageContent(msg);
  return String(content.conversation || content.extendedTextMessage?.text || "").trim();
}

function isSelfChat(chatId) {
  const myNumber = normalizeWhatsAppId(sock?.user?.id || "");
  const myLid = normalizeWhatsAppId(sock?.user?.lid || "");
  const chat = normalizeWhatsAppId(chatId);
  return Boolean(chat && (chat === myNumber || chat === myLid));
}

async function sendText(to, text) {
  const chatId = toWhatsAppJid(to);
  if (!sock || status !== "connected") {
    throw new Error("WhatsApp is not connected");
  }
  const chunks = splitMessage(text, config.messageLimit);
  if (!chunks.length) throw new Error("message is required");

  const messageIds = [];
  for (const chunk of chunks) {
    const result = await sock.sendMessage(chatId, { text: chunk });
    if (result?.key?.id) {
      messageIds.push(result.key.id);
      recentlySentIds.add(result.key.id);
      while (recentlySentIds.size > 1000) recentlySentIds.delete(recentlySentIds.values().next().value);
    }
    sent += 1;
    lastSentAt = new Date().toISOString();
  }
  return { to: chatId, messageIds };
}

async function handleWebhook(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
    return;
  }

  const to = body?.to ?? body?.chatId ?? body?.recipient ?? body?.phone;
  const message = body?.message ?? body?.text ?? body?.body;
  if (typeof message !== "string" || !message.trim()) {
    sendJson(res, 400, {
      ok: false,
      error: "message is required",
      usage: { to: "15551234567", message: "hello" },
    });
    return;
  }

  try {
    const result = await sendText(to, message);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    const isConnectionError = error.message === "WhatsApp is not connected";
    sendJson(res, isConnectionError ? 503 : 400, { ok: false, error: error.message });
  }
}

async function forwardInbound(message) {
  if (!config.inboundWebhookUrl || !config.inboundWebhookToken) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(config.inboundWebhookUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.inboundWebhookToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body || "inbound webhook failed"}`);
    }
    forwarded += 1;
  } finally {
    clearTimeout(timeout);
  }
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${config.host}`);
    const method = req.method || "GET";

    if (method === "GET" && requestUrl.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        status,
        uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        sent,
        received,
        forwarded,
        inboundEnabled: Boolean(config.inboundWebhookUrl && config.inboundWebhookToken),
        lastSentAt,
        lastReceivedAt,
      });
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/") {
      sendJson(res, 200, {
        ok: true,
        service: "whatsapp",
        endpoints: { health: "GET /health", webhook: "POST /webhook" },
      });
      return;
    }

    if (method === "POST" && ["/webhook", "/send"].includes(requestUrl.pathname)) {
      await handleWebhook(req, res);
      return;
    }

    sendJson(res, method === "POST" ? 404 : 405, { ok: false, error: "not found" });
  });

  server.on("clientError", (error, socket) => {
    log("warn", "HTTP client error", { error: error.message });
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  server.listen(config.port, config.host, () => {
    log("info", "WhatsApp HTTP service listening", { host: config.host, port: config.port });
  });
}

async function startSocket() {
  status = "connecting";
  fs.mkdirSync(config.sessionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
  const { version } = await fetchLatestBaileysVersion(
    proxyUrl ? { dispatcher: new ProxyAgent(proxyUrl) } : {}
  );
  sock = makeWASocket({
    version,
    auth: state,
    ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
    logger,
    browser: ["WhatsApp Service", "Chrome", "120.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => ({ conversation: "" }),
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (update) => {
    if (update.qr) {
      const pairingDir = process.env.PAIRING_DIR || "./pairing";
      const pngPath = path.resolve(pairingDir, "latest-qr.png");
      fs.mkdirSync(pairingDir, { recursive: true });
      await QRCode.toFile(pngPath, update.qr, { width: 768, margin: 2 });
      console.log(pathToFileURL(pngPath).href);
    }
    if (update.connection === "open") {
      status = "connected";
      log("info", "WhatsApp connected");
    }
    if (update.connection === "close") {
      const reason = update.lastDisconnect?.error?.output?.statusCode;
      status = "disconnected";
      if (reason === DisconnectReason.loggedOut || stopping) {
        process.exit(reason === DisconnectReason.loggedOut ? 1 : 0);
      }
      log("warn", "WhatsApp connection closed; reconnecting", { reason });
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startSocket().catch((error) => log("error", "WhatsApp reconnect failed", { error: error.message }));
        }, reason === 515 ? 1000 : 3000);
        reconnectTimer.unref();
      }
    }
  });
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      const text = getText(msg);
      if (!text) continue;
      const messageId = msg.key?.id || "";
      const chatId = msg.key?.remoteJid || "";
      if (msg.key?.fromMe) {
        const selfChatMessage = config.inboundMode === "self-chat" && isSelfChat(chatId);
        if (!selfChatMessage || recentlySentIds.has(messageId)) continue;
      }
      if (messageId && seenMessageIds.has(messageId)) continue;
      if (messageId) {
        seenMessageIds.add(messageId);
        while (seenMessageIds.size > 1000) seenMessageIds.delete(seenMessageIds.values().next().value);
      }
      received += 1;
      lastReceivedAt = new Date().toISOString();

      const senderId = msg.key?.participant || chatId;
      if (!isAllowedSender(senderId, config.inboundAllowedSenders)) continue;
      void forwardInbound({
        type: "whatsapp_message",
        messageId,
        chatId,
        senderId,
        body: text,
        timestamp: Number(msg.messageTimestamp || Date.now()),
      }).catch((error) => log("warn", "inbound webhook failed", { error: error.message }));
    }
  });
}

process.on("SIGTERM", () => {
  stopping = true;
  process.exit(0);
});
process.on("SIGINT", () => {
  stopping = true;
  process.exit(0);
});

startHttpServer();
await startSocket();
