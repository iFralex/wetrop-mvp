import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Store } from "./store.ts";
import {
  buildWikiSearchPage,
  normalizeWikiSearchPage,
} from "../../llm-wiki/mcp-server/src/search-page.ts";
export function updateWiki(store: Store, document: any) {
  const raw = `wiki/raw/sources/${document.id}.txt`;
  if (!existsSync(store.scope.path(raw)))
    writeFileSync(
      store.scope.parent(raw),
      `Original: ${document.path}\nSHA-256: ${document.hash}\n\n${document.text}`,
      { flag: "wx" },
    );
  const page = `wiki/wiki/document-${document.id}.md`;
  writeFileSync(
    store.scope.parent(page),
    `---\ntitle: ${JSON.stringify(document.name)}\ntype: source\nsources:\n  - ${document.path}\n---\n# ${document.name}\n\n[[company]]\n\nStatus: source extraction; not a verified fiscal interpretation.\n\nSource: ${document.path}\n\n${document.text.slice(0, 100000)}\n`,
  );
  return graph(store);
}
export function searchWiki(store: Store, query: string, offset = 0) {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const results = store.scope
    .files("wiki/wiki")
    .filter((p) => p.endsWith(".md"))
    .map((path) => {
      const text = readFileSync(store.scope.path(path), "utf8");
      return {
        path,
        title: text.match(/^# (.+)$/m)?.[1] ?? path,
        snippet: text.slice(0, 3000),
        score: terms.reduce(
          (s, t) => s + (text.toLowerCase().includes(t) ? 1 : 0),
          0,
        ),
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const page = normalizeWikiSearchPage(5, offset);
  return buildWikiSearchPage(
    { results, mode: "company-text" },
    page.limit,
    page.offset,
  );
}
export function graph(store: Store) {
  const nodes: any[] = [];
  const edges: any[] = [];
  for (const path of store.scope
    .files("wiki/wiki")
    .filter((p) => p.endsWith(".md"))) {
    const text = readFileSync(store.scope.path(path), "utf8");
    const id = path.split("/").at(-1)!.replace(/\.md$/, "");
    nodes.push({
      id,
      label: text.match(/^# (.+)$/m)?.[1] ?? id,
      type: text.match(/^type: (.+)$/m)?.[1] ?? "entity",
      path,
      linkCount: 0,
    });
    for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g))
      edges.push({ source: id, target: m[1], weight: 1 });
  }
  for (const doc of store.documents()) {
    nodes.push({
      id: doc.id,
      label: doc.name,
      type: "document",
      path: doc.path,
      linkCount: 0,
    });
    edges.push({ source: "company", target: doc.id, weight: 1 });
  }
  for (const action of store.cases()) {
    const id = `case-${action.id}`;
    nodes.push({ id, label: action.title, type: "practice", linkCount: 0 });
    edges.push({ source: "company", target: id, weight: 1 });
    for (const p of store.payload(action.id).results) {
      const doc = store.document(p);
      if (doc) edges.push({ source: id, target: doc.id, weight: 1 });
    }
  }
  for (const event of store.db
    .prepare("SELECT * FROM calendar")
    .all() as any[]) {
    nodes.push({
      id: event.id,
      label: event.title,
      type: "deadline",
      linkCount: 0,
    });
    edges.push({ source: "company", target: event.id, weight: 1 });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const valid = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  for (const n of nodes)
    n.linkCount = valid.filter(
      (e) => e.source === n.id || e.target === n.id,
    ).length;
  const result = { nodes, edges: valid };
  writeFileSync(
    store.scope.parent("wiki/graph.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}
