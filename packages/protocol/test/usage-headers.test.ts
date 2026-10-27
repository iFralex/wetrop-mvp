import assert from "node:assert/strict";
import test from "node:test";
import { usageHeaders, USAGE_SERVICE_HEADER, USAGE_ACTION_HEADER, USAGE_SESSION_HEADER } from "../src/index.ts";

test("usageHeaders builds the attribution headers, session optional", () => {
  assert.deepEqual(usageHeaders("mail-promoter", "triage"), {
    "x-usage-service": "mail-promoter",
    "x-usage-action": "triage",
  });
  assert.deepEqual(usageHeaders("host", "agent-turn", "chat-1"), {
    "x-usage-service": "host",
    "x-usage-action": "agent-turn",
    "x-usage-session": "chat-1",
  });
  assert.equal(USAGE_SERVICE_HEADER, "x-usage-service");
  assert.equal(USAGE_ACTION_HEADER, "x-usage-action");
  assert.equal(USAGE_SESSION_HEADER, "x-usage-session");
});

test('a shared gateway credential never leaks to a direct provider endpoint',async()=>{
  const {gatewayCredential}=await import('../src/index.ts');
  assert.equal(gatewayCredential('http://127.0.0.1:4000/v1/embeddings',undefined,'private'),'private');
  assert.equal(gatewayCredential('https://provider.test/v1/embeddings',undefined,'private'),undefined);
  assert.equal(gatewayCredential('http://127.0.0.1:11434/v1/embeddings',undefined,'private'),undefined);
});
