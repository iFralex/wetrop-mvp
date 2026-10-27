import { execFile } from "node:child_process";
import { localScope } from "./setup.ts";
import { ChatGPTAuth } from "./chatgpt-auth.ts";
localScope();
const auth = new ChatGPTAuth();
const flow = await auth.start();
console.log(
  "Complete Wetrop sign-in in your browser:\n" +
    flow.url +
    "\nCredentials will remain inside wetrop-mvp/.runtime/chatgpt.",
);
execFile("open", [flow.url], () => {});
await flow.done;
const status = auth.status();
if (!status.connected || status.login?.status !== "connected")
  throw new Error(status.login?.error ?? "Sign-in was not completed");
const models = await auth.models();
if (!models.length)
  throw new Error("No ChatGPT plan models available for this account");
await auth.selectModel(models[0].id);
console.log("Wetrop is connected. Selected model: " + models[0].name);
auth.close();
