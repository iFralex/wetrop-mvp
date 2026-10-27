import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { localScope, runtimePath } from "./setup.ts";
import { Store } from "./store.ts";
import { seedDemo } from "./seed.ts";
if (!process.argv.includes("--confirm"))
  throw new Error(
    "Use npm run wetrop:reset -- --confirm. Stop the broker and tools container first. Existing data is archived inside .runtime, never deleted.",
  );
const scope = localScope();
const pid = scope.path(".wetrop/jobs/broker.pid", true);
if (existsSync(pid)) {
  try {
    process.kill(Number(readFileSync(pid, "utf8")), 0);
    throw new Error("Stop the Wetrop broker before resetting the demo");
  } catch (e) {
    if ((e as any).code !== "ESRCH") throw e;
  }
}
try {
  const running = execFileSync(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", "wetrop-tools"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (running === "true")
    throw new Error(
      "Stop wetrop-tools before resetting: docker compose -f compose.wetrop.yml down",
    );
} catch (e) {
  if ((e as any).message?.startsWith("Stop wetrop")) throw e;
}
const marker = scope.path(".wetrop/demo-marker", true);
if (
  !existsSync(marker) ||
  readFileSync(marker, "utf8").trim() !== "wetrop-demo:aurora"
)
  throw new Error("Refusing to reset a folder without the Wetrop demo marker");
const backup = runtimePath(`reset-archive-${Date.now()}`);
renameSync(scope.root, backup);
const s = new Store(localScope());
try {
  await seedDemo(s);
} finally {
  s.close();
}
console.log(`Demo reset. Previous company data preserved in ${backup}`);
