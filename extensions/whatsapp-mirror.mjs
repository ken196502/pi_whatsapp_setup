#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readDotEnv(cwd) {
  const values = {};
  const projectEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  const candidates = [...new Set([projectEnv, path.resolve(cwd, ".env")])];
  for (const filePath of candidates) {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const index = trimmed.indexOf("=");
        if (index < 0) continue;
        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key && values[key] === undefined) values[key] = value;
      }
    } catch {
      // Environment variables are enough when no project .env is available.
    }
  }
  return values;
}

function getText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("")
    .trim();
}

function mirror(text, settings) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  return fetch(settings.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: settings.to, message: text }),
    signal: controller.signal,
  }).then(async (response) => {
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { error: raw || `HTTP ${response.status}` };
    }
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  }).finally(() => clearTimeout(timeout));
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) {
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

function startInboundServer(settings, onMessage, notify) {
  if (!settings.inboundToken) {
    notify("WhatsApp inbound is disabled: set PI_WHATSAPP_INBOUND_TOKEN or INBOUND_WEBHOOK_TOKEN", "warning");
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${settings.inboundHost}`);
    if (req.method !== "POST" || requestUrl.pathname !== settings.inboundPath) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    const authorization = String(req.headers.authorization || "");
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const supplied = bearer || String(req.headers["x-webhook-token"] || "");
    if (supplied !== settings.inboundToken) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    try {
      const message = await readJson(req);
      if (typeof message.body !== "string" || !message.body.trim()) {
        sendJson(res, 400, { ok: false, error: "body is required" });
        return;
      }
      await onMessage(message);
      sendJson(res, 202, { ok: true });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
  });

  server.on("error", (error) => notify(`WhatsApp inbound listener failed: ${error.message}`, "error"));
  server.listen(settings.inboundPort, settings.inboundHost, () => {
    notify(`WhatsApp inbound listener: http://${settings.inboundHost}:${settings.inboundPort}${settings.inboundPath}`);
  });
  return server;
}

export default function whatsappMirror(pi) {
  let settings;
  let configErrorShown = false;
  let inboundServer;
  const seenInboundIds = new Set();

  function getSettings(cwd) {
    if (settings) return settings;
    const fileEnv = readDotEnv(cwd);
    const env = { ...fileEnv, ...process.env };
    const host = env.WHATSAPP_HOST || "127.0.0.1";
    const port = env.WHATSAPP_PORT || "3091";
    settings = {
      url: env.PI_WHATSAPP_WEBHOOK_URL || env.WHATSAPP_WEBHOOK_URL ||
        `http://${host}:${port}/webhook`,
      token: env.PI_WHATSAPP_WEBHOOK_TOKEN || env.WEBHOOK_TOKEN || "",
      to: env.PI_WHATSAPP_TO || env.WHATSAPP_TO || "",
      inboundHost: env.PI_WHATSAPP_INBOUND_HOST || "127.0.0.1",
      inboundPort: Number.parseInt(env.PI_WHATSAPP_INBOUND_PORT || "3092", 10),
      inboundPath: env.PI_WHATSAPP_INBOUND_PATH || "/whatsapp/inbound",
      inboundToken: env.PI_WHATSAPP_INBOUND_TOKEN || env.INBOUND_WEBHOOK_TOKEN || env.WEBHOOK_TOKEN || "",
    };
    return settings;
  }

  function showConfigError(ctx) {
    if (configErrorShown) return;
    configErrorShown = true;
    ctx.ui.notify(
      "WhatsApp mirror is not configured: set PI_WHATSAPP_TO and PI_WHATSAPP_WEBHOOK_TOKEN",
      "warning",
    );
  }

  pi.on("session_start", (_event, ctx) => {
    const current = getSettings(ctx.cwd);
    inboundServer = startInboundServer(current, async (message) => {
      if (message.messageId && seenInboundIds.has(message.messageId)) return;
      if (message.messageId) {
        seenInboundIds.add(message.messageId);
        while (seenInboundIds.size > 1000) seenInboundIds.delete(seenInboundIds.values().next().value);
      }
      const sender = message.senderId || message.chatId || "unknown";
      await pi.sendUserMessage(`[WhatsApp ${sender}]\n${message.body}`, { deliverAs: "followUp" });
    }, (message, type) => ctx.ui.notify(message, type));
  });

  pi.on("session_shutdown", () => {
    inboundServer?.close();
    inboundServer = undefined;
  });

  pi.on("message_end", (event, ctx) => {
    const text = getText(event.message);
    if (!text) return;

    const current = getSettings(ctx.cwd);
    if (!current.to || !current.token) {
      showConfigError(ctx);
      return;
    }

    void mirror(text, current).catch((error) => {
      ctx.ui.notify(`WhatsApp mirror failed: ${error.message}`, "error");
    });
  });
}

export { getText };
