import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorStore } from '../src/vector-store.ts';

test('persistent read-only worker reuses preparation and sees subsequent index updates', async () => {
  const dir=mkdtempSync(join(tmpdir(),'vector-worker-'));
  const db=new Database(join(dir,'index.db'));
  db.pragma('journal_mode=WAL');
  const state=new Map<string,string>();
  const vectors=new VectorStore(db,{table:'vec_fixture',getState:key=>state.get(key),setState:(key,value)=>{state.set(key,value);}});
  vectors.enable();vectors.ensureTable(3);vectors.upsert(1,[1,0,0]);vectors.upsert(2,[0,1,0]);
  try {
    await vectors.prepare();
    assert.deepEqual(await vectors.knnAsync([1,0,0],2),vectors.knn([1,0,0],2));
    vectors.upsert(3,[0,0,1]);
    assert.equal((await vectors.knnAsync([0,0,1],1))[0].rowid,3);
    assert.deepEqual(await vectors.prepare(),{});
  } finally {vectors.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('missing vector metadata skips preparation without opening a worker',async()=>{
  const db=new Database(':memory:');
  const vectors=new VectorStore(db,{table:'vec_empty',getState:()=>undefined,setState:()=>{}});
  try {assert.match((await vectors.prepare()).skipped!,/No vector/);}finally{vectors.close();db.close();}
});

test('Mail, Calendar and Contacts preparation warms their real lexical table shapes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'vector-lexical-'));
  const db=new Database(join(dir,'index.db'));db.pragma('journal_mode=WAL');
  db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(subject,body_text);
    CREATE VIRTUAL TABLE messages_trig USING fts5(subject,body_text,tokenize='trigram');
    CREATE VIRTUAL TABLE events_fts USING fts5(summary);
    CREATE VIRTUAL TABLE contacts_fts USING fts5(display_name);
    INSERT INTO messages_fts VALUES ('project','project');
    INSERT INTO messages_trig VALUES ('project','project');
    INSERT INTO events_fts VALUES ('meeting');
    INSERT INTO contacts_fts VALUES ('università');`);
  try {
    for(const table of ['vec_messages','vec_events','vec_contacts']) {
      const state=new Map<string,string>();
      const vectors=new VectorStore(db,{table,getState:key=>state.get(key),setState:(key,value)=>{state.set(key,value);}});
      try {vectors.enable();vectors.ensureTable(2);vectors.upsert(1,[1,0]);await vectors.prepare();assert.equal((await vectors.knnAsync([1,0],1))[0].rowid,1);}
      finally{vectors.close();}
    }
  } finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
