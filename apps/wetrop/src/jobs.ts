import { Store } from "./store.ts";
export interface JobAgent {
  run(job: any): Promise<string>;
}
/** Shared by the production scheduler and the first-person acceptance driver. */
export class JobRunner {
  private processing = false;
  constructor(
    readonly store: Store,
    readonly agent: JobAgent,
    readonly emit: (event: any) => void = () => {},
  ) {}
  async next() {
    if (this.processing) return false;
    const s = this.store;
    const job = s.db.transaction(() => {
      const pending = s.db
        .prepare(
          "SELECT * FROM jobs WHERE state='pending' ORDER BY rowid LIMIT 1",
        )
        .get() as any;
      if (!pending) return;
      const claim = s.db
        .prepare(
          "UPDATE jobs SET state='running' WHERE id=? AND state='pending'",
        )
        .run(pending.id);
      return claim.changes ? pending : undefined;
    })();
    if (!job) return false;
    this.processing = true;
    this.emit({ type: "working", conversation: job.conversation });
    try {
      const answer = await this.agent.run(job);
      s.db.transaction(() => {
        s.message(job.conversation, "assistant", answer, job.case_id);
        if (job.role === "client")
          s.outbox(
            "message",
            { text: answer, caseId: job.case_id },
            `answer:${job.id}`,
          );
        s.db
          .prepare("UPDATE jobs SET state='done',error=NULL WHERE id=?")
          .run(job.id);
      })();
      this.emit({ type: "done", conversation: job.conversation });
    } catch (e) {
      const error = e instanceof Error ? e.message : "Agent failed";
      s.db
        .prepare("UPDATE jobs SET state='failed',error=? WHERE id=?")
        .run(error, job.id);
      if (job.case_id)
        s.updateCase(job.case_id, { state: "Failed", failure: error });
      s.audit("job.failed", error, { jobId: job.id });
      this.emit({ type: "error", text: error, conversation: job.conversation });
    } finally {
      this.processing = false;
    }
    return true;
  }
}
