import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { remoteRequest } from "./bridge.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
/** Small compatibility surface for the existing Steward stores, backed by Node 24 SQLite. */
let fence: ((path: string) => void) | undefined;
export function setDatabaseFence(handler?: (path: string) => void) {
  fence = handler;
}
class CompanyDatabase {
  private readonly connection!: DatabaseSync;
  private readonly remote =
    process.platform === "linux" && process.env.WETROP_DB_BRIDGE === "1";
  private readonly session = randomUUID();
  private depth = 0;
  private closed = false;
  readonly name: string;
  readonly readonly: boolean;
  constructor(
    path: string,
    options: { readonly?: boolean; fileMustExist?: boolean } = {},
  ) {
    if (options.fileMustExist && path !== ":memory:" && !existsSync(path))
      throw new Error("Database does not exist");
    this.name = path;
    this.readonly = !!options.readonly;
    if (this.remote) {
      remoteRequest(process.env.COMPANY_ROOT!, this.session, "open", {
        path: relative(process.env.COMPANY_ROOT!, path),
        readonly: this.readonly,
      });
      return;
    }
    this.connection = new DatabaseSync(path, {
      readOnly: this.readonly,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    this.connection.exec("PRAGMA busy_timeout=5000");
  }
  get open() {
    return !this.closed;
  }
  exec(sql: string) {
    if (this.remote) {
      remoteRequest(process.env.COMPANY_ROOT!, this.session, "exec", { sql });
      return this;
    }
    fence?.(this.name);
    this.connection.exec(sql);
    return this;
  }
  prepare(sql: string): any {
    if (this.remote)
      return {
        run: (...values: any[]) =>
          remoteRequest(process.env.COMPANY_ROOT!, this.session, "run", {
            sql,
            values,
          }),
        get: (...values: any[]) =>
          remoteRequest(process.env.COMPANY_ROOT!, this.session, "get", {
            sql,
            values,
          }),
        all: (...values: any[]) =>
          remoteRequest(process.env.COMPANY_ROOT!, this.session, "all", {
            sql,
            values,
          }),
      };
    fence?.(this.name);
    const statement = this.connection.prepare(sql);
    statement.setAllowBareNamedParameters(true);
    statement.setAllowUnknownNamedParameters(true);
    const row = (r: any) => (r ? { ...r } : undefined);
    return {
      run: (...args: any[]) => {
        fence?.(this.name);
        return statement.run(...args);
      },
      get: (...args: any[]) => {
        fence?.(this.name);
        return row(statement.get(...args));
      },
      all: (...args: any[]) => {
        fence?.(this.name);
        return statement.all(...args).map(row);
      },
      iterate: function* (...args: any[]) {
        for (const r of statement.iterate(...args)) yield row(r);
      },
    };
  }
  pragma(sql: string, options: { simple?: boolean } = {}) {
    // Keep the existing stores on rollback journals. All connections belong
    // to the host kernel; Linux processes must use the file bridge.
    if (/^journal_mode\s*=\s*wal$/i.test(sql.trim()))
      sql = "journal_mode = DELETE";
    const rows = this.prepare("PRAGMA " + sql).all();
    return options.simple ? Object.values(rows[0] ?? {})[0] : rows;
  }
  transaction<T extends (...args: any[]) => any>(fn: T): T {
    const run = ((...args: any[]) => {
      const point = "wetrop_" + this.depth;
      const outer = this.depth === 0;
      this.exec(outer ? "BEGIN" : `SAVEPOINT ${point}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${point}`);
        return result;
      } catch (e) {
        this.exec(outer ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${point}`);
        if (!outer) this.exec(`RELEASE SAVEPOINT ${point}`);
        throw e;
      } finally {
        this.depth--;
      }
    }) as T;
    return run;
  }
  close() {
    if (!this.closed) {
      if (this.remote)
        remoteRequest(process.env.COMPANY_ROOT!, this.session, "close", {});
      else {
        fence?.(this.name);
        this.connection.close();
      }
      this.closed = true;
    }
  }
}
namespace CompanyDatabase {
  export type Database = CompanyDatabase;
}
export default CompanyDatabase;
