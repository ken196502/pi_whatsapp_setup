import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import {
  isAllowedSender,
  loadEnvFile,
  normalizeWhatsAppId,
  parseAllowedSenders,
  splitMessage,
  toWhatsAppJid,
} from "../src/lib.mjs";
import { getText, mirror } from "../extensions/whatsapp-mirror.mjs";

describe("lib helpers", () => {
  it("loads a simple env file without overwriting existing values", () => {
    const target = { EXISTING: "keep" };
    loadEnvFile("/definitely/missing/.env", target);
    assert.equal(target.EXISTING, "keep");
  });

  it("normalizes WhatsApp identifiers", () => {
    assert.equal(normalizeWhatsAppId("+1 555-123-4567@s.whatsapp.net"), "15551234567");
    assert.equal(normalizeWhatsAppId("15551234567:22@s.whatsapp.net"), "15551234567");
  });

  it("filters inbound senders", () => {
    const allowed = parseAllowedSenders("15551234567, +852 6123 4567");
    assert.equal(isAllowedSender("15551234567@s.whatsapp.net", allowed), true);
    assert.equal(isAllowedSender("85261234567@s.whatsapp.net", allowed), true);
    assert.equal(isAllowedSender("15550000000@s.whatsapp.net", allowed), false);
    assert.equal(isAllowedSender("anything@s.whatsapp.net", parseAllowedSenders("*")), true);
  });

  it("converts phone numbers and preserves JIDs", () => {
    assert.equal(toWhatsAppJid("+1 555-123-4567"), "15551234567@s.whatsapp.net");
    assert.equal(toWhatsAppJid("15551234567:22@s.whatsapp.net"), "15551234567@s.whatsapp.net");
    assert.equal(toWhatsAppJid("120363000000000000@g.us"), "120363000000000000@g.us");
    assert.throws(() => toWhatsAppJid(""), /to is required/);
  });

  it("splits long messages", () => {
    assert.deepEqual(splitMessage("a b c", 3), ["a b", "c"]);
  });

  it("extracts only assistant text for mirroring", () => {
    assert.equal(
      getText({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "hello" }] }),
      "hello",
    );
    assert.equal(getText({ role: "user", content: [{ type: "text", text: "hello" }] }), "");
  });

  it("sends loopback mirror requests directly", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        assert.equal(req.headers.authorization, "Bearer test-token");
        assert.deepEqual(JSON.parse(body), { to: "15551234567", message: "hello" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      await mirror("hello", {
        url: `http://127.0.0.1:${port}/webhook`,
        token: "test-token",
        to: "15551234567",
      });
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
