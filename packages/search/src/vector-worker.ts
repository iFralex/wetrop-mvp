import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const { path, table } = workerData as { path: string; table: string };
if (!/^vec_[a-z_]+$/.test(table)) throw new Error('Invalid vector table');
const db = new Database(path, { readonly: true, fileMustExist: true });
db.pragma('query_only=ON');
db.pragma('mmap_size=2147483648');
db.pragma('cache_size=-65536');
sqliteVec.load(db);
type Request = { id: number; vector: number[]; limit: number; warmup: boolean };
const queued: Request[] = [];
let scheduled = false;
function drain() {
  scheduled = false;
  // Interactive requests overtake preparation that has not started yet.
  queued.sort((a,b) => Number(a.warmup)-Number(b.warmup));
  const request = queued.shift();
  if (!request) return;
  try {
    const hits = db.prepare(`SELECT rowid,distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
      .all(JSON.stringify(request.vector), request.limit);
    if (request.warmup) {
      // Warm bounded lexical pages too; never materialize source bodies here.
      const lexical = table === 'vec_messages'
        ? [
          ['SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? LIMIT 1', '"project"'],
          ['SELECT rowid FROM messages_trig WHERE subject MATCH ? LIMIT 1', '"project"'],
          ['SELECT rowid FROM messages_trig WHERE body_text MATCH ? LIMIT 1', '"project"'],
        ]
        : table === 'vec_events' ? [['SELECT rowid FROM events_fts WHERE events_fts MATCH ? LIMIT 1', '"meeting"']]
        : table === 'vec_contacts' ? [['SELECT rowid FROM contacts_fts WHERE contacts_fts MATCH ? LIMIT 1', '"università"']] : [];
      for (const [sql, query] of lexical) db.prepare(sql).get(query);
    }
    parentPort!.postMessage({ id: request.id, hits });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
  if (queued.length) { scheduled = true; setImmediate(drain); }
}
parentPort!.on('message', (request: Request) => {
  queued.push(request);
  if (!scheduled) { scheduled = true; setImmediate(drain); }
});
