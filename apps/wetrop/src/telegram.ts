import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Store } from "./store.ts";
const MAX = 20 * 1024 * 1024;
export class Telegram {
  constructor(
    readonly store: Store,
    private readonly token = process.env.WETROP_TELEGRAM_TOKEN,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  get configured() {
    return !!this.token;
  }
  async api(method: string, payload: any, form?: FormData) {
    if (!this.token) throw new Error("Telegram token is not configured");
    const r = await this.fetcher(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: form ? undefined : { "Content-Type": "application/json" },
        body: form ?? JSON.stringify(payload),
        signal: AbortSignal.timeout(40000),
      },
    );
    const result: any = await r.json();
    if (!result.ok)
      throw new Error(
        `Telegram ${method} rejected (${result.error_code ?? r.status})`,
      );
    return result.result;
  }
  async poll() {
    if (!this.token) return;
    const offset = this.store.meta<number>("telegramOffset", 0);
    const updates = await this.api("getUpdates", {
      offset,
      timeout: 1,
      allowed_updates: ["message"],
    });
    for (const update of updates) {
      try {
        await this.accept(update);
        this.store.set("telegramOffset", update.update_id + 1);
      } catch (e) {
        const error =
          e instanceof Error ? e.message : "Telegram receive failed";
        this.store.audit("telegram.receive_failed", error, {
          updateId: update.update_id,
        });
        this.store.db
          .prepare(
            "INSERT OR REPLACE INTO updates(id,state,error) VALUES (?,'failed',?)",
          )
          .run(update.update_id, error);
        const m = update.message;
        if (
          m?.chat?.type === "private" &&
          this.store.db
            .prepare("SELECT 1 FROM bindings WHERE chat_id=? AND user_id=?")
            .get(String(m.chat.id), String(m.from?.id))
        )
          this.store.outbox(
            "message",
            {
              text: "Non sono riuscito ad acquisire questo messaggio o allegato. Prova a reinviarlo indicando il numero della pratica.",
              chatId: String(m.chat.id),
            },
            `receive-failed:${update.update_id}`,
          );
        this.store.set("telegramOffset", update.update_id + 1);
      }
    }
  }
  async accept(update: any) {
    const s = this.store;
    const existing = s.db
      .prepare("SELECT state FROM updates WHERE id=?")
      .get(update.update_id) as any;
    if (existing?.state === "done") return;
    const m = update.message;
    if (!m || m.chat?.type !== "private") {
      s.db
        .prepare("INSERT OR REPLACE INTO updates(id,state) VALUES (?,'done')")
        .run(update.update_id);
      return;
    }
    const chat = String(m.chat.id),
      user = String(m.from?.id),
      text = String(m.text ?? m.caption ?? "");
    if (text.startsWith("/start ")) {
      s.bind(text.slice(7).trim(), chat, user);
      s.outbox(
        "message",
        {
          text: "Collegamento ad Aurora Servizi completato. Puoi chiedermi documenti, dati o una bozza.",
          chatId: chat,
        },
        `paired:${update.update_id}`,
      );
      s.db
        .prepare("INSERT OR REPLACE INTO updates(id,state) VALUES (?,'done')")
        .run(update.update_id);
      return;
    }
    if (
      !s.db
        .prepare("SELECT 1 FROM bindings WHERE chat_id=? AND user_id=?")
        .get(chat, user)
    ) {
      s.audit("telegram.unauthorized", "Ignored an unpaired sender");
      s.db
        .prepare("INSERT OR REPLACE INTO updates(id,state) VALUES (?,'done')")
        .run(update.update_id);
      return;
    }
    let caseId: number | undefined;
    const reply = m.reply_to_message?.message_id;
    if (reply)
      caseId = (
        s.db
          .prepare("SELECT case_id FROM telegram_requests WHERE message_id=?")
          .get(reply) as any
      )?.case_id;
    const explicit = text.match(/(?:pratica|practice|case|#)\s*#?(\d+)/i);
    if (explicit) {
      s.getCase(+explicit[1]);
      caseId = +explicit[1];
    }
    const file = m.document ?? m.photo?.at(-1);
    let path: string | undefined;
    if (file) {
      const waiting = s
        .cases()
        .filter((c) => s.payload(c.id).state === "Waiting for client");
      if (!caseId && waiting.length === 1) caseId = waiting[0].id;
      if (!caseId && waiting.length > 1) {
        s.outbox(
          "message",
          {
            text: "A quale pratica appartiene questo allegato? Invia di nuovo il file rispondendo al messaggio della pratica oppure indicando #numero.",
            chatId: chat,
          },
          `ambiguous:${update.update_id}`,
        );
        s.db
          .prepare("INSERT OR REPLACE INTO updates(id,state) VALUES (?,'done')")
          .run(update.update_id);
        return;
      }
      if (file.file_size > MAX) throw new Error("Telegram file exceeds 20 MiB");
      const meta = await this.api("getFile", { file_id: file.file_id });
      if (!meta.file_path || meta.file_size > MAX)
        throw new Error("Telegram file is too large or unavailable");
      const r = await this.fetcher(
        `https://api.telegram.org/file/bot${this.token}/${meta.file_path}`,
        { signal: AbortSignal.timeout(30000) },
      );
      if (!r.ok || !r.body) throw new Error("Telegram file download failed");
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = r.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX) throw new Error("Download size limit exceeded");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const name = String(file.file_name ?? "photo.jpg")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(-100);
      path = `documents/originals/telegram-${update.update_id}-${name}`;
      const bytes = Buffer.concat(chunks);
      try {
        writeFileSync(s.scope.parent(path), bytes, { flag: "wx", mode: 0o600 });
      } catch (e) {
        if ((e as any).code !== "EEXIST") throw e;
      }
    }
    if (!caseId && !/^(nuova richiesta|new request)\b/i.test(text)) {
      const waiting = s
        .cases()
        .filter((c) => s.payload(c.id).state === "Waiting for client");
      if (waiting.length === 1) caseId = waiting[0].id;
      else if (waiting.length > 1) {
        s.outbox(
          "message",
          {
            text: "Indica la pratica (#numero), oppure scrivi “nuova richiesta” per iniziare una richiesta distinta.",
            chatId: chat,
          },
          `choose:${update.update_id}`,
        );
        s.db
          .prepare("INSERT OR REPLACE INTO updates(id,state) VALUES (?,'done')")
          .run(update.update_id);
        return;
      }
    }
    s.db.transaction(() => {
      s.message(
        `telegram:${chat}`,
        "client",
        text + (path ? `\n[Company attachment: ${path}]` : ""),
        caseId,
      );
      if (caseId && s.payload(caseId).state === "Waiting for client")
        s.updateCase(caseId, { state: "In progress" });
      s.enqueue(
        "client",
        `telegram:${chat}`,
        text +
          (path
            ? `\nReceived attachment at ${path}. Inspect, index and continue the original practice.`
            : ""),
        caseId,
        `telegram:${update.update_id}`,
      );
      s.db
        .prepare("INSERT OR REPLACE INTO updates(id,state) VALUES (?,'done')")
        .run(update.update_id);
    })();
  }
  async deliver() {
    if (!this.token) return;
    const s = this.store;
    const binding = s.db.prepare("SELECT * FROM bindings LIMIT 1").get() as any;
    if (!binding) return;
    for (const row of s.db
      .prepare(
        "SELECT * FROM outbox WHERE state='pending' ORDER BY created LIMIT 10",
      )
      .all() as any[]) {
      const p = JSON.parse(row.payload);
      if (p.chatId && p.chatId !== binding.chat_id) {
        s.db
          .prepare(
            "UPDATE outbox SET state='failed',error='Recipient is not paired' WHERE id=?",
          )
          .run(row.id);
        continue;
      }
      const claimed = s.db
        .prepare(
          "UPDATE outbox SET state='sending' WHERE id=? AND state='pending'",
        )
        .run(row.id);
      if (!claimed.changes) continue;
      const operation = s.journal.start({
        kind: "telegram.send",
        input: { outboxId: row.id, kind: row.kind },
        expected: { chatId: binding.chat_id },
      });
      try {
        let result: any;
        if (row.kind === "document") {
          const document = s.document(p.path);
          if (!document) throw new Error("Unregistered attachment");
          const bytes = s.verifyDocument(document);
          if (bytes.length > MAX)
            throw new Error("Document exceeds demo Telegram limit");
          const form = new FormData();
          form.set("chat_id", binding.chat_id);
          form.set("caption", String(p.text ?? "").slice(0, 1000));
          form.set("document", new Blob([bytes]), p.path.split("/").at(-1));
          result = await this.api("sendDocument", null, form);
        } else
          result = await this.api("sendMessage", {
            chat_id: binding.chat_id,
            text: String(p.text).slice(0, 4000),
          });
        s.db.transaction(() => {
          s.db
            .prepare("UPDATE outbox SET state='confirmed',result=? WHERE id=?")
            .run(JSON.stringify({ messageId: result.message_id }), row.id);
          if (p.caseId) {
            s.db
              .prepare("INSERT OR REPLACE INTO telegram_requests VALUES (?,?)")
              .run(result.message_id, p.caseId);
            if (p.completePractice)
              s.updateCase(p.caseId, { state: "Completed" });
          }
        })();
        s.journal.markConfirmed(operation, { messageId: result.message_id });
        s.audit("telegram.sent", "Telegram delivery confirmed", {
          operationId: row.id,
          messageId: result.message_id,
        });
      } catch (e) {
        s.journal.markNeedsReview(
          operation,
          e instanceof Error ? e.message : "Uncertain Telegram delivery",
        );
        s.db
          .prepare("UPDATE outbox SET state='unknown',error=? WHERE id=?")
          .run(
            e instanceof Error ? e.message : "Telegram delivery uncertain",
            row.id,
          );
        s.audit("telegram.uncertain", "Delivery needs manual verification", {
          operationId: row.id,
        });
      }
    }
  }
}
