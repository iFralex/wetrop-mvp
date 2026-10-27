import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { registerGatewayModel } from "../../host/src/core/pi-provider.ts";
import { CompanyScope, initializeScope } from "../src/scope.ts";
import { projectRoot } from "../src/setup.ts";
test("reused Pi provider streams a dedicated model without reading or creating personal auth files", async () => {
  const parent = join(projectRoot, ".runtime/tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "sdk-"));
  const scope = new CompanyScope(root);
  initializeScope(scope);
  let requested = false;
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const c of req) data += c;
    const request = JSON.parse(data);
    assert.equal(req.headers.authorization, "Bearer test-wetrop-key");
    assert.equal(request.model, "test-wetrop-model");
    requested = true;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      "data: " +
        JSON.stringify({
          id: "test",
          object: "chat.completion.chunk",
          model: "test-wetrop-model",
          created: 1,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Hello Aurora." },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n",
    );
    res.write(
      "data: " +
        JSON.stringify({
          id: "test",
          object: "chat.completion.chunk",
          model: "test-wetrop-model",
          created: 1,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }) +
        "\n\n",
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as any;
  const { modelRegistry, model, authStorage } = registerGatewayModel({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    tier: "test-wetrop-model",
    apiKey: "test-wetrop-key",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const settingsManager = SettingsManager.inMemory();
  const agentDir = scope.mkdir(".wetrop/jobs/pi", true);
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    systemPrompt: "Reply briefly.",
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  let session: any;
  try {
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      noTools: "builtin",
      customTools: [],
    }));
    let text = "";
    session.subscribe((e: any) => {
      if (
        e.type === "message_update" &&
        e.assistantMessageEvent?.type === "text_delta"
      )
        text += e.assistantMessageEvent.delta;
    });
    await session.prompt("Hello");
    assert.equal(requested, true);
    assert.match(text, /Hello Aurora/);
    assert.equal(existsSync(join(agentDir, "auth.json")), false);
  } finally {
    session?.dispose();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual reused MCP transport exposes only the local company calendar for clients", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  const parent = join(projectRoot, ".runtime/tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "mcp-"));
  const scope = new CompanyScope(root);
  initializeScope(scope);
  const client = new Client(
    { name: "wetrop-test", version: "1.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          join(projectRoot, "apps/calendar-mcp/src/index.ts"),
        ],
        env: {
          COMPANY_ROOT: root,
          WETROP_ROLE: "client",
          TMPDIR: scope.path(".wetrop/tmp", true),
        },
      }),
    );
    const list = await client.listTools();
    assert.ok(list.tools.some((t) => t.name === "list_calendars"));
    assert.equal(
      list.tools.some((t) => t.name === "create_event"),
      false,
    );
    const result: any = await client.callTool({
      name: "list_calendars",
      arguments: {},
    });
    assert.match(result.content[0].text, /company/);
    const denied: any = await client.callTool({
      name: "create_event",
      arguments: { title: "bad" },
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
