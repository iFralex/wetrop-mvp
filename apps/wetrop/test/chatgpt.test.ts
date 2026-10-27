import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { ChatGPTAuth } from "../src/chatgpt-auth.ts";
import { projectRoot } from "../src/setup.ts";
const root = join(projectRoot, ".runtime/tests");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, "oauth-"));
after(() => rmSync(dir, { recursive: true, force: true }));
function fixture(id: string) {
  let nonce = "";
  let calls = 0;
  let scopes =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  const path = join(dir, id + ".json");
  const fetcher = (async (url: any, init: any) => {
    calls++;
    if (String(url).endsWith("/oauth/token")) {
      const form = init.body as URLSearchParams;
      assert.equal(form.get("resource"), "https://api.openai.com/v1");
      assert.equal(form.get("client_id"), "oaiapp_wetrop_test");
      return new Response(
        JSON.stringify({
          access_token: "test-access",
          refresh_token: "test-refresh",
          id_token: "test-id",
          expires_in: 3600,
          scope: scopes,
        }),
      );
    }
    if (String(url).endsWith("/models"))
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: "test-model",
              display_name: "Test model",
              visibility: "list",
            },
            { slug: "hidden", visibility: "hidden" },
          ],
        }),
      );
    throw new Error("Unexpected network endpoint");
  }) as typeof fetch;
  const auth = new ChatGPTAuth({
    path,
    fetcher,
    verify: async () => ({
      sub: "test-subject",
      nonce,
      email: "demo@example.invalid",
    }),
  });
  return {
    auth,
    path,
    fetcher,
    setNonce: (n: string) => (nonce = n),
    setScopes: (s: string) => (scopes = s),
    calls: () => calls,
  };
}
async function login(
  f: ReturnType<typeof fixture>,
  client = "oaiapp_wetrop_test",
) {
  const flow = await f.auth.start();
  const url = new URL(flow.url);
  f.setNonce(url.searchParams.get("nonce")!);
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  callback.searchParams.set("code", "test-code");
  callback.searchParams.set("client_id", client);
  const response = await fetch(callback);
  await flow.done;
  return { response, url, callback };
}
test("ChatGPT PKCE uses the issued client ID and stores only private local credentials", async () => {
  const f = fixture("valid");
  try {
    const { response, url } = await login(f);
    assert.equal(response.status, 200);
    assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(url.searchParams.get("agent_name_hint"), "Wetrop");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(f.auth.status().connected, true);
    assert.ok(!JSON.stringify(f.auth.status()).includes("test-access"));
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(await f.auth.token(), "test-access");
    const models = await f.auth.models();
    assert.deepEqual(models, [{ id: "test-model", name: "Test model" }]);
    await f.auth.selectModel("test-model");
    assert.equal(f.auth.status().model, "test-model");
    await assert.rejects(() => f.auth.selectModel("hidden"));
    const again = await f.auth.start();
    assert.equal(
      new URL(again.url).searchParams.get("client_id"),
      "oaiapp_wetrop_test",
    );
  } finally {
    f.auth.close();
  }
});
test("callback state mismatch does not consume a pending ChatGPT login", async () => {
  const f = fixture("state");
  const flow = await f.auth.start();
  try {
    const url = new URL(flow.url);
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", "wrong");
    callback.searchParams.set("code", "test");
    assert.equal((await fetch(callback)).status, 403);
    assert.equal(f.calls(), 0);
    assert.equal(f.auth.status().login?.status, "pending");
    assert.equal(f.auth.status().connected, false);
  } finally {
    f.auth.close();
  }
});
test("identity-only consent is rejected as a model provider", async () => {
  const f = fixture("scope");
  f.setScopes("openid profile email");
  try {
    const { response } = await login(f);
    assert.equal(response.status, 400);
    assert.equal(f.auth.status().connected, false);
    assert.match(f.auth.status().login?.error ?? "", /not authorized/);
  } finally {
    f.auth.close();
  }
});
test("dynamic registration entrypoint cannot be saved as the issued client ID", async () => {
  const f = fixture("client");
  try {
    const { response } = await login(f, "dynamic_agent_client");
    assert.equal(response.status, 400);
    assert.equal(f.calls(), 0);
    assert.equal(f.auth.status().connected, false);
  } finally {
    f.auth.close();
  }
});
test("token renewal is serialized across independent auth instances", async () => {
  const f = fixture("refresh");
  try {
    await login(f);
    const saved = JSON.parse(readFileSync(f.path, "utf8"));
    saved.accounts[saved.active].expiresAt = 1;
    writeFileSync(f.path, JSON.stringify(saved));
    const second = new ChatGPTAuth({ path: f.path, fetcher: f.fetcher });
    const before = f.calls();
    const result = await Promise.all([
      f.auth.token(),
      second.token(),
      f.auth.token(),
    ]);
    assert.deepEqual(result, ["test-access", "test-access", "test-access"]);
    assert.equal(f.calls(), before + 1);
  } finally {
    f.auth.close();
  }
});
