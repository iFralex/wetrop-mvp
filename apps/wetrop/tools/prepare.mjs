import { createRequire } from "node:module";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const asset = resolve(root, ".runtime/ocr-assets");
mkdirSync(asset, { recursive: true });
const pkg = require("@napi-rs/canvas/package.json");
const name = `@napi-rs/canvas-linux-${process.arch === "arm64" ? "arm64" : "x64"}-gnu`;
const version = pkg.optionalDependencies[name];
const target = resolve(root, "node_modules", name);
if (!existsSync(resolve(target, "package.json"))) {
  const dir = resolve(root, ".runtime/native-packages");
  mkdirSync(dir, { recursive: true });
  console.log("Preparing Linux PDF rasterizer", name, version);
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        `${name}@${version}`,
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        dir,
        "--cache",
        resolve(root, ".runtime/npm-cache"),
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  mkdirSync(target, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    resolve(dir, packed[0].filename),
    "-C",
    target,
    "--strip-components",
    "1",
  ]);
}
for (const lang of ["eng", "ita"]) {
  const path = resolve(asset, lang + ".traineddata");
  if (existsSync(path)) continue;
  console.log("Preparing offline OCR language", lang);
  const r = await fetch(
    `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${lang}.traineddata`,
    { signal: AbortSignal.timeout(90000) },
  );
  if (!r.ok) throw new Error("OCR language download failed: " + r.status);
  writeFileSync(path, new Uint8Array(await r.arrayBuffer()), { flag: "wx" });
}
console.log(
  "Portable tools prepared. No token or personal archive is mounted into the tool container.",
);
