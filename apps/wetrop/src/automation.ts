import { WatchEngine, WatchStore } from "@steward/watch-engine";
import { Store } from "./store.ts";
export class Automation {
  readonly engine: WatchEngine;
  readonly watches: WatchStore;
  constructor(readonly store: Store) {
    this.watches = WatchStore.open(
      store.scope.path(".wetrop/jobs/watches.db", true),
    );
    this.engine = new WatchEngine(this.watches).register({
      source: "company-deadline",
      snapshot: async (id) => {
        const e = store.db
          .prepare("SELECT * FROM calendar WHERE id=?")
          .get(id) as any;
        if (!e) throw new Error("Unknown deadline");
        const now = store.meta<number>("demoNow", Date.now());
        return {
          ...e,
          ready:
            !!e.enabled && now >= Date.parse(e.due) - e.lead_days * 86400000,
        };
      },
      events: (_previous, current: any) =>
        current.ready
          ? [
              {
                key: `deadline:${current.id}:${current.period}`,
                type: "deadline.ready",
                timestamp: Date.now(),
                data: { id: current.id },
                currentState: current,
                fallbackText: current.task,
              },
            ]
          : [],
      defaultExpiry: () => Date.now() + 10 * 365 * 86400000,
      isTerminal: () => false,
    });
  }
  async tick() {
    const s = this.store;
    for (const e of s.db
      .prepare("SELECT * FROM calendar WHERE enabled=1")
      .all() as any[]) {
      const found = this.watches.raw
        .prepare("SELECT id FROM watches WHERE source=? AND resource_ref=?")
        .get("company-deadline", e.id);
      if (!found)
        await this.engine.create({
          source: "company-deadline",
          resourceRef: e.id,
          chatId: "studio",
          instruction: e.task,
          rules: [{ id: "start", event: "deadline.ready", once: true }],
        });
    }
    await this.engine.poll();
    for (const event of this.watches.pending()) {
      const e = event.event.currentState as any;
      s.db.transaction(() => {
        const id = s.createCase(
          e.task,
          "deadline",
          `deadline:${e.id}:${e.period}`,
          e.period,
        );
        s.enqueue(
          "accountant",
          "studio",
          `Configured internal deadline: ${e.title}. Prepare the requested dossier for ${e.period}. ${e.task}. This is a preparatory task, not a fiscal filing.`,
          id,
          `deadline-job:${e.id}:${e.period}`,
        );
      })();
      this.watches.delivered(event.id);
    }
    const now = s.meta<number>("demoNow", Date.now());
    for (const c of s.cases()) {
      const p = s.payload(c.id);
      if (p.state !== "Waiting for client" || !p.lastRequestAt) continue;
      const count = p.reminders ?? 0;
      const age = now - p.lastRequestAt;
      if (
        (count === 0 && age >= 86400000) ||
        (count === 1 && age >= 3 * 86400000)
      ) {
        s.db.transaction(() => {
          s.outbox(
            "message",
            {
              text: `Promemoria pratica #${c.id}: mancano ancora ${p.missing.join("; ")}. Rispondi al messaggio della pratica con i dati o gli allegati.`,
              caseId: c.id,
            },
            `reminder:${c.id}:${p.lastRequestAt}:${count + 1}`,
          );
          s.updateCase(c.id, { reminders: count + 1 });
        })();
      } else if (count === 2 && age >= 5 * 86400000) {
        s.updateCase(c.id, {
          reminders: 3,
          failure:
            "Client has not responded after two reminders. Accountant follow-up required.",
        });
      }
    }
  }
  close() {
    this.watches.raw.close();
  }
}
