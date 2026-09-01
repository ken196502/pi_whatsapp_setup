#!/usr/bin/env node
import fs from "node:fs";
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
import { loadEnvFile } from "./lib.mjs";

loadEnvFile(path.resolve(".env"));

const sessionDir = process.env.SESSION_DIR || "./session";
const pairingDir = process.env.PAIRING_DIR || "./pairing";
const proxyUrl = process.env.PI_WHATSAPP_PROXY || process.env.HTTPS_PROXY ||
  process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";

fs.mkdirSync(sessionDir, { recursive: true });
fs.mkdirSync(pairingDir, { recursive: true });

function writeStatus(status) {
  fs.writeFileSync(
    path.join(pairingDir, "latest-status.json"),
    `${JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2)}\n`
  );
}

async function writeQr(qr) {
  const pngPath = path.resolve(pairingDir, "latest-qr.png");
  const htmlPath = path.resolve(pairingDir, "latest-qr.html");
  await QRCode.toFile(pngPath, qr, { width: 768, margin: 2 });
  fs.writeFileSync(path.join(pairingDir, "latest-qr.txt"), `${qr}\n`);
  fs.writeFileSync(
    htmlPath,
    `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="20">
  <title>WhatsApp Service Pairing QR</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; background: #f7f7f5; color: #111; }
    main { max-width: 820px; margin: 0 auto; }
    img { width: min(92vw, 720px); height: auto; background: white; padding: 16px; border: 1px solid #ddd; }
    code { background: #eee; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>WhatsApp Service Pairing QR</h1>
    <p>Open WhatsApp, go to <code>Linked devices</code>, and scan this QR.</p>
    <img src="latest-qr.png?ts=${Date.now()}" alt="WhatsApp pairing QR">
    <p>This page refreshes every 20 seconds because WhatsApp QR codes rotate.</p>
  </main>
</body>
</html>
`
  );
  writeStatus({ status: "qr_ready", pngPath, htmlPath });
  console.log(pathToFileURL(pngPath).href);
}

const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
const { version } = await fetchLatestBaileysVersion(
  proxyUrl ? { dispatcher: new ProxyAgent(proxyUrl) } : {}
);
const sock = makeWASocket({
  version,
  auth: state,
  ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
  logger: pino({ level: "warn" }),
  browser: ["Pi WhatsApp Setup", "Chrome", "120.0"],
  syncFullHistory: false,
  markOnlineOnConnect: false,
  getMessage: async () => ({ conversation: "" }),
});

writeStatus({ status: "starting" });
sock.ev.on("creds.update", saveCreds);
sock.ev.on("connection.update", async (update) => {
  if (update.qr) await writeQr(update.qr);
  if (update.connection === "open") {
    writeStatus({ status: "connected" });
    console.error("WhatsApp connected. Credentials saved.");
    setTimeout(() => process.exit(0), 2000);
  }
  if (update.connection === "close") {
    const reason = update.lastDisconnect?.error?.output?.statusCode;
    writeStatus({ status: "closed", reason });
    if (reason === DisconnectReason.loggedOut) process.exit(1);
  }
});
