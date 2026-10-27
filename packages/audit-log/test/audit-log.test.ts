import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { AuditLog, redact } from "../src/index.ts";

test("redact removes common secrets and truncates long strings", () => {
  const value = redact({
    apiKey: "sk-12345678901234567890",
    nested: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
    text: "x".repeat(700),
  }) as Record<string, unknown>;
  assert.equal(value.apiKey, "[Redacted]");
  assert.deepEqual((value.nested as Record<string, unknown>).Authorization, "[Redacted]");
  assert.match(String(value.text), /\[truncated/);
});

test("records and queries audit events", () => {
  const audit = new AuditLog(new Database(":memory:"));
  audit.record({
    actor: "host",
    eventType: "tool.gated",
    risk: "high",
    summary: "Gated send_email",
    chatId: "chat-1",
    toolName: "mcp__mail__send_email",
    ok: true,
    payload: { to: "a@example.com", token: "secret" },
  });
  const page = audit.query({ q: "send_email" });
  assert.equal(page.events.length, 1);
  assert.equal(page.totals.events, 1);
  assert.equal(page.totals.highRisk, 1);
  assert.equal((page.events[0].redactedPayloadJson as Record<string, unknown>).token, "[Redacted]");
});

test("redact snippets body/html/content fields instead of storing them in full", () => {
  const value = redact({
    body: "x".repeat(300),
    html: "y".repeat(300),
    content: "z".repeat(300),
    subject: "short and fine",
  }) as Record<string, unknown>;
  assert.equal((value.body as string).length, 120);
  assert.equal((value.html as string).length, 120);
  assert.equal((value.content as string).length, 120);
  assert.equal(value.subject, "short and fine");
});

test("the raw unredacted payload never touches disk, even for a fresh field name", () => {
  const audit = new AuditLog(new Database(":memory:"));
  const secretRawMarker = "RAW-PAYLOAD-MUST-NOT-BE-STORED";
  audit.record({
    actor: "host",
    eventType: "mail.read",
    summary: "Read message",
    // "fullBody" isn't covered by CONTENT_KEY_RE — this asserts the DB-level
    // guarantee (payload_json === redacted copy), not just field-name matching.
    payload: { fullBody: secretRawMarker },
  });
  const row = audit.raw.prepare("SELECT payload_json, redacted_payload_json FROM audit_events").get() as {
    payload_json: string;
    redacted_payload_json: string;
  };
  assert.equal(row.payload_json, row.redacted_payload_json);
});

test('summary, source refs and body snippets all redact credentials before persistence', () => {
  const audit=new AuditLog(new Database(':memory:'));
  audit.record({actor:'host',eventType:'test',summary:'password=super-secret',
    payload:{body:'token https://example.test/?token=private-token password=body-secret'},
    sourceRefs:[{type:'file',url:'https://user:pass@example.test/?api_key=link-secret',label:'authorization=hidden-value'}]});
  const row=audit.raw.prepare('SELECT summary,payload_json,source_refs_json FROM audit_events').get() as any;
  const serialized=JSON.stringify(row);
  for(const secret of ['super-secret','private-token','body-secret','link-secret','hidden-value','user:pass']) assert.equal(serialized.includes(secret),false,secret);
});
