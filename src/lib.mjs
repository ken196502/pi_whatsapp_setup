import fs from "node:fs";

export function loadEnvFile(filePath, target = process.env) {
  if (!fs.existsSync(filePath)) return target;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && target[key] === undefined) target[key] = value;
  }
  return target;
}

export function normalizeWhatsAppId(value) {
  return String(value || "")
    .trim()
    .replace(/:.*@/, "@")
    .replace(/@.*/, "")
    .replace(/^\+/, "")
    .replace(/[^\d]/g, "");
}

export function parseAllowedSenders(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (value === "*" ? "*" : normalizeWhatsAppId(value)))
      .filter(Boolean)
  );
}

export function isAllowedSender(senderId, allowedSenders) {
  return Boolean(
    allowedSenders?.size &&
    (allowedSenders.has("*") || allowedSenders.has(normalizeWhatsAppId(senderId)))
  );
}

export function toWhatsAppJid(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("to is required");

  if (/@(?:g\.us|s\.whatsapp\.net|lid)$/i.test(input)) {
    return input.toLowerCase().replace(/:\d+(?=@)/, "");
  }

  const phone = normalizeWhatsAppId(input);
  if (!phone) throw new Error("to must be a phone number or WhatsApp JID");
  return `${phone}@s.whatsapp.net`;
}

export function splitMessage(text, limit = 3900) {
  const input = String(text || "").trim();
  if (!input) return [];
  const chunks = [];
  let rest = input;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
