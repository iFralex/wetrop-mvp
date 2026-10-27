import { CompanyScope } from "../../../apps/wetrop/src/scope.ts";
import { DatabaseSync } from "node:sqlite";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { resolve, relative, join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { setDatabaseFence } from "./index.ts";
const sleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function remoteRequest(
  root: string,
  session: string,
  operation: string,
  args: any,
) {
  const dir = join(root, ".wetrop/database/bridge");
  mkdirSync(dir, { recursive: true });
  const id = randomUUID(),
    request = join(dir, id + ".req"),
    response = join(dir, id + ".res");
  const temp = request + ".tmp";
  writeFileSync(
    temp,
    JSON.stringify({ session, operation, args, expires: Date.now() + 15000 }),
    { flag: "wx", mode: 0o600 },
  );
  renameSync(temp, request);
  const deadline = Date.now() + 17000;
  while (!existsSync(response)) {
    if (Date.now() > deadline) {
      rmSync(request, { force: true });
      throw new Error(
        "Company database bridge timed out; do not repeat uncertain writes automatically",
      );
    }
    sleep(3);
  }
  const result = JSON.parse(readFileSync(response, "utf8"));
  rmSync(response, { force: true });
  if (result.error) throw new Error(result.error);
  return result.result;
}
/** All SQLite access stays on the host kernel. Guests exchange regular JSON files,
 * never SQLite WAL/shared-memory pages across the Docker bind mount. */
export class DatabaseBridge {
  private timer?: ReturnType<typeof setInterval>;
  private readonly sessions = new Map<
    string,
    { db: DatabaseSync; path: string; lease: number }
  >();
  private readonly owners = new Map<string, string>();
  private readonly dir: string;
  constructor(readonly root: string) {
    this.root = resolve(root);
    this.dir = join(this.root, ".wetrop/database/bridge");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  start() {
    this.timer = setInterval(() => this.pump(), 3);
    setDatabaseFence((path) => this.fence(path));
    return this;
  }
  private fence(path: string) {
    const full = resolve(path),
      deadline = Date.now() + 16000;
    while (this.owners.has(full)) {
      this.pump();
      if (Date.now() > deadline)
        throw new Error("Company database transaction is busy");
      sleep(3);
    }
  }
  private path(input: string) {
    if (!input.startsWith(".wetrop/"))
      throw new Error("Invalid database bridge path");
    return new CompanyScope(this.root).path(input, true);
  }
  private pump() {
    for (const [id, s] of this.sessions)
      if (this.owners.get(s.path) === id && s.lease < Date.now()) {
        try {
          s.db.exec("ROLLBACK");
        } catch {}
        this.owners.delete(s.path);
      }
    for (const name of readdirSync(this.dir)
      .filter((n) => n.endsWith(".req"))
      .slice(0, 100)) {
      const file = join(this.dir, name);
      if (statSync(file).size > 8 * 1024 * 1024) {
        rmSync(file, { force: true });
        continue;
      }
      let input: any;
      try {
        input = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const session = this.sessions.get(input.session);
      if (
        session &&
        this.owners.has(session.path) &&
        this.owners.get(session.path) !== input.session
      )
        continue;
      const response = join(this.dir, name.replace(/\.req$/, ".res"));
      let output: any;
      try {
        if (input.expires < Date.now())
          throw new Error("Expired database request was not executed");
        let result: any;
        if (input.operation === "open") {
          const path = this.path(input.args.path);
          const db = new DatabaseSync(path, {
            readOnly: !!input.args.readonly,
            allowExtension: false,
          });
          db.exec("PRAGMA busy_timeout=1000");
          this.sessions.set(input.session, {
            db,
            path,
            lease: Date.now() + 10000,
          });
          result = true;
        } else {
          if (!session) throw new Error("Unknown database session");
          session.lease = Date.now() + 10000;
          if (input.operation === "close") {
            try {
              session.db.exec("ROLLBACK");
            } catch {}
            this.owners.delete(session.path);
            session.db.close();
            this.sessions.delete(input.session);
            result = true;
          } else if (input.operation === "exec") {
            const sql = String(input.args.sql);
            if (/^BEGIN\b/i.test(sql))
              this.owners.set(session.path, input.session);
            try {
              session.db.exec(sql);
            } catch (e) {
              if (/^BEGIN\b/i.test(sql)) this.owners.delete(session.path);
              throw e;
            }
            if (/^(COMMIT|ROLLBACK)$/i.test(sql.trim()))
              this.owners.delete(session.path);
            result = true;
          } else {
            const st = session.db.prepare(input.args.sql);
            st.setAllowBareNamedParameters(true);
            st.setAllowUnknownNamedParameters(true);
            const args = input.args.values ?? [];
            if (input.operation === "run") result = st.run(...args);
            else if (input.operation === "get") result = st.get(...args);
            else if (input.operation === "all") result = st.all(...args);
            else throw new Error("Unknown database operation");
          }
        }
        output = { result };
      } catch (e) {
        output = {
          error: e instanceof Error ? e.message : "Database operation failed",
        };
      }
      const temp = response + ".tmp";
      writeFileSync(temp, JSON.stringify(output), { mode: 0o600 });
      renameSync(temp, response);
      rmSync(file, { force: true });
    }
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    setDatabaseFence(undefined);
    for (const { db } of this.sessions.values()) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      db.close();
    }
    this.sessions.clear();
    this.owners.clear();
  }
}
