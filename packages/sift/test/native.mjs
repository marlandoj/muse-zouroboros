import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sift } from "../plugins/opencode/sift.js";
import piPlugin from "../plugins/pi/sift.ts";

const state = mkdtempSync(join(tmpdir(), "sift-native-"));
process.env.SIFT_HOME = state;
let count = 0;
function check(value, message) { assert.ok(value, message); count++; }
function fixture(format) {
  const messages = [{role: "user", content: "Keep user instructions"}, {role: "assistant", content: "Start"}];
  for (let i = 0; i < 2; i++) {
    if (format === "opencode") messages.push({info: {role: "assistant", sessionID: "native-test"}, parts: [
      {type: "tool", callID: `c${i}`, tool: "read", state: {status: "completed", input: {filePath: "/fixture.py"}, output: "fixture text\n".repeat(6000)}},
    ]});
    else messages.push(
      {role: "assistant", content: [{type: "toolCall", id: `c${i}`, name: "read", arguments: {path: "/fixture.py"}}]},
      {role: "toolResult", toolCallId: `c${i}`, toolName: "read", isError: false, content: [{type: "text", text: "fixture text\n".repeat(6000)}]},
    );
  }
  messages.push(...Array.from({length: 9}, (_, i) => ({role: "assistant", content: `recent ${i}`})));
  return messages;
}
try {
  const open = await Sift();
  const handlers = {};
  piPlugin({on: (name, handler) => {handlers[name] = handler;}});
  const ctx = {sessionManager: {getSessionId: () => "native-test"}};
  for (const harness of ["opencode", "pi"]) {
    const original = fixture(harness);
    for (const mode of ["shadow", "live"]) {
      process.env.SIFT_MODE = mode;
      const payload = {messages: structuredClone(original)};
      const returned = harness === "opencode"
        ? await open["experimental.chat.messages.transform"]({}, payload)
        : await handlers.context(payload, ctx);
      const messages = returned?.messages ?? payload.messages;
      check((JSON.stringify(messages) !== JSON.stringify(original)) === (mode === "live"), `${harness} ${mode}`);
      check(JSON.stringify(messages.slice(-8)) === JSON.stringify(original.slice(-8)), "recent preserved");
      check(JSON.stringify(messages.slice(0, 2)) === JSON.stringify(original.slice(0, 2)), "instructions preserved");
    }
    process.env.SIFT_MODE = "live";
    process.env.SIFT = "0";
    const payload = {messages: structuredClone(original)};
    if (harness === "opencode") await open["experimental.chat.messages.transform"]({}, payload);
    else check(await handlers.context(payload, ctx) === undefined, "Pi disabled no override");
    check(JSON.stringify(payload.messages) === JSON.stringify(original), `${harness} disabled`);
    delete process.env.SIFT;
  }
  delete process.env.SIFT_MODE;
  writeFileSync(join(state, "config.json"), "broken");
  const payload = {messages: fixture("opencode")};
  const before = JSON.stringify(payload);
  await open["experimental.chat.messages.transform"]({}, payload);
  check(JSON.stringify(payload) === before, "invalid config fail open");
  check(readFileSync(join(state, "receipts.jsonl"), "utf8").includes('"applied":true'), "request receipt recorded");
  console.log(`${count} native JS/TS plugin assertions passed`);
} finally {
  rmSync(state, {recursive: true});
}
