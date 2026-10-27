import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AUDIT_DIR = mkdtempSync(join(tmpdir(), "write-ops-audit-test-"));
import { test } from "node:test";
import { WriteOpsStore } from "../src/index.ts";
import { auditLog, type AuditActor } from "@steward/audit-log";

const mk = (actor?: AuditActor) => WriteOpsStore.open(":memory:", actor);
const op = { kind: "mail.send" as const, input: { to: ["a@b.co"], subject: "x", body: "hi" }, expected: { bodySnippet: "hi" } };

test("startScheduled enqueues and lists; dueScheduled gates on time", () => {
  const s = mk();
  const now = Math.floor(Date.now() / 1000);
  const id = s.startScheduled(op, now + 3600);
  assert.equal(s.listScheduled().length, 1);
  assert.equal(s.listScheduled()[0].id, id);
  assert.equal(s.listScheduled()[0].scheduledFor, now + 3600);
  assert.equal(s.dueScheduled(now).length, 0, "not due yet");
  assert.equal(s.dueScheduled(now + 3600).length, 1, "due once its time arrives");
  s.close();
});

test("cancelScheduled removes a pending op; returns false once fired", () => {
  const s = mk();
  const now = Math.floor(Date.now() / 1000);
  const id = s.startScheduled(op, now);
  assert.equal(s.cancelScheduled(id), true);
  assert.equal(s.listScheduled().length, 0);
  const id2 = s.startScheduled(op, now);
  s.scriptReturned(id2);
  assert.equal(s.cancelScheduled(id2), false, "a fired op is no longer cancellable");
  s.close();
});

test("a fired scheduled op flows into the confirmation queue", () => {
  const s = mk();
  const id = s.startScheduled(op, Math.floor(Date.now() / 1000));
  s.scriptReturned(id, { scheduled: true });
  assert.equal(s.listScheduled().length, 0);
  const pending = s.pendingForConfirmation(["mail.send"]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, id);
  s.close();
});

test("a stale started operation is reconciled after a crash but an in-flight one is not", () => {
  const s = mk();
  const fresh = s.start(op);
  assert.equal(s.pendingForConfirmation(["mail.send"]).some((row) => row.id === fresh), false);
  s.raw.prepare("UPDATE write_ops SET updated_at=? WHERE id=?").run(Math.floor(Date.now() / 1000) - 61, fresh);
  assert.equal(s.pendingForConfirmation(["mail.send"]).some((row) => row.id === fresh), true);
  s.close();
});

test("audit events are attributed to the store's actor, not always 'host'", () => {
  const host = mk(); // default
  const hostId = host.start(op);
  host.close();
  const hostEvent = auditLog().query({ eventType: "write.started" }).events.find((e) => e.correlationId === hostId);
  assert.equal(hostEvent?.actor, "host");

  const scheduler = mk("scheduler");
  const schedulerId = scheduler.startScheduled(op, Math.floor(Date.now() / 1000));
  scheduler.scriptReturned(schedulerId, { scheduled: true });
  scheduler.close();
  const scheduledEvent = auditLog().query({ eventType: "write.scheduled" }).events.find((e) => e.correlationId === schedulerId);
  const returnedEvent = auditLog().query({ eventType: "write.script_returned" }).events.find((e) => e.correlationId === schedulerId);
  assert.equal(scheduledEvent?.actor, "scheduler");
  assert.equal(returnedEvent?.actor, "scheduler");
});

test('two processes cannot both claim the same due send and a crash cannot requeue it', () => {
  const dir=mkdtempSync(join(tmpdir(),'write-claim-'));
  const a=WriteOpsStore.open(join(dir,'ops.db')), b=WriteOpsStore.open(join(dir,'ops.db'));
  const now=Math.floor(Date.now()/1000), id=a.startScheduled(op,now);
  assert.equal(a.claimScheduled(id,now)?.attemptedAt,now);
  assert.equal(b.claimScheduled(id,now),null);
  assert.equal(b.dueScheduled(now+3600).length,0);
  a.close(); b.close();
  const restarted=WriteOpsStore.open(join(dir,'ops.db'));
  assert.equal(restarted.claimScheduled(id,now+3600),null);
  restarted.markNeedsReview(id,'Inspect Sent and approve a new send');
  assert.equal(restarted.get(id)?.status,'needs_review');
  assert.equal(restarted.dueScheduled(now+3600).length,0);
  restarted.close();
});
