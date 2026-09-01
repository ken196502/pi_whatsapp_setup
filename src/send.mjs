#!/usr/bin/env node
import path from "node:path";
import { loadEnvFile } from "./lib.mjs";

loadEnvFile(path.resolve(".env"));

function usage() {
  return [
    "Usage: npm run send -- --to <phone-or-jid> --message <text>",
    "",
    "Environment:",
    "  PI_WHATSAPP_WEBHOOK_URL or WHATSAPP_WEBHOOK_URL  webhook URL",
    "  PI_WHATSAPP_WEBHOOK_TOKEN or WEBHOOK_TOKEN        webhook token",
    "  WHATSAPP_TO                                      default recipient",
  ].join("\n");
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!["--to", "--message", "--url"].includes(arg)) {
      throw new Error(`unknown option: ${arg}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const host = process.env.WHATSAPP_HOST || "127.0.0.1";
  const port = process.env.WHATSAPP_PORT || "3091";
  const url = options.url || process.env.PI_WHATSAPP_WEBHOOK_URL ||
    process.env.WHATSAPP_WEBHOOK_URL || `http://${host}:${port}/webhook`;
  const token = process.env.PI_WHATSAPP_WEBHOOK_TOKEN || process.env.WEBHOOK_TOKEN || "";
  const to = options.to || process.env.WHATSAPP_TO || "";
  const message = options.message || "";

  if (!token) throw new Error("PI_WHATSAPP_WEBHOOK_TOKEN or WEBHOOK_TOKEN is required");
  if (!to) throw new Error(`--to or WHATSAPP_TO is required\n\n${usage()}`);
  if (!message.trim()) throw new Error(`--message is required\n\n${usage()}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ to, message }),
  });
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { ok: false, error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(`webhook failed with HTTP ${response.status}: ${body.error || raw}`);
  }
  console.log(JSON.stringify(body));
}

main().catch((error) => {
  console.error(`whatsapp send: ${error.message}`);
  process.exitCode = 1;
});
