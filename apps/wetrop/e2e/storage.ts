import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import Database from "../../../packages/sqlite/src/index.ts";
import { DatabaseBridge } from "../../../packages/sqlite/src/bridge.ts";
import { CompanyScope, initializeScope } from "../src/scope.ts";
import { projectRoot } from "../src/setup.ts";
const root = resolve(projectRoot, ".runtime/storage-test-" + process.pid);
const scope = new CompanyScope(root);
initializeScope(scope);
const db = new Database(scope.path(".wetrop/database/stress.db", true));
db.exec(
  "CREATE TABLE counter(value INTEGER NOT NULL); INSERT INTO counter VALUES(0)",
);
const bridge = new DatabaseBridge(root).start();
const args = [
  "run",
  "--rm",
  "--read-only",
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--user",
  `${process.getuid!()}:${process.getgid!()}`,
  "-e",
  "COMPANY_ROOT=/company",
  "-e",
  "WETROP_DB_BRIDGE=1",
  "--mount",
  `type=bind,source=${root},target=/company`,
  ...["node_modules", "apps", "packages"].flatMap((p) => [
    "--mount",
    `type=bind,source=${resolve(projectRoot, p)},target=/app/${p},readonly`,
  ]),
  "--mount",
  `type=bind,source=${resolve(projectRoot, "package.json")},target=/app/package.json,readonly`,
  "-w",
  "/app",
  "public.ecr.aws/docker/library/node:24-bookworm-slim",
  "node",
  "--experimental-transform-types",
  "--input-type=module",
  "-e",
  `import Database from '/app/packages/sqlite/src/index.ts';import fs from'node:fs';const d=new Database('/company/.wetrop/database/stress.db');fs.writeFileSync('/company/ready','1');for(let i=0;i<50;i++)d.transaction(()=>d.prepare('UPDATE counter SET value=value+1').run())();d.close();try{fs.readFileSync('/app/.runtime/chatgpt/accounts.json');throw new Error('Private credentials were mounted')}catch(e){if(e.code!=='ENOENT')throw e;}try{fs.writeFileSync('/app/package.json','wrong');throw new Error('Source was writable')}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e;}await fetch('https://api.openai.com',{signal:AbortSignal.timeout(1000)}).then(()=>{throw new Error('Unexpected network access')},()=>{});console.log('guest complete');`,
];
const child = spawn("docker", args, {
  cwd: projectRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (b) => (output += b));
child.stderr.on("data", (b) => (output += b));
const done = new Promise<number | null>((r) => child.once("exit", r));
try {
  for (let i = 0; !existsSync(resolve(root, "ready")); i++) {
    if (i > 1000 || child.exitCode !== null)
      throw new Error(output || "Guest did not start");
    await new Promise((r) => setTimeout(r, 5));
  }
  for (let i = 0; i < 50; i++) {
    db.transaction(() =>
      db.prepare("UPDATE counter SET value=value+1").run(),
    )();
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(await done, 0, output);
  assert.equal(db.prepare("SELECT value FROM counter").get().value, 100);
  assert.deepEqual(db.prepare("PRAGMA integrity_check").all(), [
    { integrity_check: "ok" },
  ]);
  console.log(
    "Concurrent host/guest SQLite bridge: 100/100 updates, integrity OK. Private tokens absent, code read-only, network denied.",
  );
} finally {
  child.kill();
  bridge.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
