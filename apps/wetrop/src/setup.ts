import { resolve, relative, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { CompanyScope } from "./scope.ts";
export const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
export function runtimePath(name: string) {
  const scope = new CompanyScope(realpathSync(projectRoot));
  return scope.parent(`.runtime/${name}`, true);
}

export function localScope() {
  const config = runtimePath("config.env");
  if (process.env.WETROP_TEST_MODE !== "1" && existsSync(config))
    for (const line of readFileSync(config, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]])
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  const root = resolve(
    process.env.COMPANY_ROOT ?? join(projectRoot, "company"),
  );
  const rel = relative(realpathSync(projectRoot), root);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Company data must be inside this Wetrop checkout");
  const projectScope = new CompanyScope(projectRoot);
  projectScope.mkdir(rel, true);
  const scope = new CompanyScope(root);
  const actual = relative(realpathSync(projectRoot), scope.root);
  if (actual.startsWith("..") || isAbsolute(actual))
    throw new Error("Company root may not resolve outside Wetrop");
  process.env.COMPANY_ROOT = scope.root;
  process.env.PI_CODING_AGENT_DIR = runtimePath("pi");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  return scope;
}
export function accessToken() {
  const p = runtimePath("access-token");
  if (!existsSync(p))
    writeFileSync(p, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    });
  return readFileSync(p, "utf8").trim();
}
