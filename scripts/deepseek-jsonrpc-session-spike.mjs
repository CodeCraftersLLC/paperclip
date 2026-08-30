#!/usr/bin/env node
/**
 * Phase 0 spike: two JSON-RPC session/prompt calls on one sessionId.
 *
 * Default path speaks to an in-process mock of dsh-jsonrpc-agent (no API key).
 * Set DEEPSEEK_SPIKE_RUNTIME to a real `dsh-jsonrpc-agent` binary (and
 * DEEPSEEK_API_KEY + DSH_CORDIS_CONFIG) to exercise the live harness.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

const SESSION_ID = "paperclip-spike-session-1";

function encode(id, method, params) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

async function runAgainstMock() {
  const child = spawn(process.execPath, ["-e", MOCK_RUNTIME], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const result = await driveClient(child);
  console.log(JSON.stringify({ mode: "mock", ...result }, null, 2));
  if (!result.toolName || result.runs !== 2 || result.sessionId !== SESSION_ID) {
    process.exitCode = 1;
  }
}

async function runAgainstRuntime(command) {
  const args = process.env.DEEPSEEK_SPIKE_RUNTIME_ARGS
    ? JSON.parse(process.env.DEEPSEEK_SPIKE_RUNTIME_ARGS)
    : [];
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  const result = await driveClient(child);
  console.log(JSON.stringify({ mode: "runtime", command, ...result }, null, 2));
}

async function driveClient(child) {
  let nextId = 1;
  const pending = new Map();
  const events = [];
  let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let toolName = null;

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method === "session.event") {
      events.push(msg.params?.event);
      const event = msg.params?.event;
      if (event?.type === "tool/call") toolName = event.data?.name ?? toolName;
      if (event?.type === "assistant/message" && event.data?.usage) {
        const u = event.data.usage;
        usage = {
          inputTokens: usage.inputTokens + Number(u.inputTokens ?? 0),
          outputTokens: usage.outputTokens + Number(u.outputTokens ?? 0),
          cachedInputTokens: usage.cachedInputTokens + Number(u.cacheReadTokens ?? 0),
        };
      }
    }
  });

  const request = (method, params) => {
    const id = nextId++;
    const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(encode(id, method, params));
    return p;
  };

  await request("initialize", {
    cwd: process.cwd(),
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  });

  for (const prompt of ["First heartbeat: list the workspace.", "Second heartbeat: continue."]) {
    await request("session/prompt", {
      sessionId: SESSION_ID,
      contentBlocks: [{ type: "text", text: prompt }],
    });
    await waitForIdle(rl, events, SESSION_ID);
  }

  await request("shutdown", {});
  child.stdin.end();
  await Promise.race([once(child, "exit"), sleep(2_000)]);
  rl.close();

  return {
    sessionId: SESSION_ID,
    runs: 2,
    toolName,
    usage,
    eventTypes: events.map((event) => event?.type).filter(Boolean),
  };
}

function waitForIdle(rl, events, sessionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for idle")), 15_000);
    const onLine = (line) => {
      try {
        const msg = JSON.parse(line);
        if (
          msg.method === "session.status" &&
          msg.params?.sessionId === sessionId &&
          msg.params?.status === "idle"
        ) {
          clearTimeout(timer);
          rl.off("line", onLine);
          resolve();
        }
      } catch {
        // ignore non-JSON
      }
    };
    rl.on("line", onLine);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MOCK_RUNTIME = `
import { createInterface } from "node:readline";
let seq = 0;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
  if (msg.method === "initialize") {
    reply({ serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.1.1-rc.2" } });
    return;
  }
  if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    const messageId = "msg-" + (++seq);
    reply({ messageId });
    notify("session.status", { sessionId, status: "running" });
    notify("session.event", { sessionId, event: { type: "user/message", seq: seq, data: { content: msg.params.contentBlocks } } });
    notify("session.event", { sessionId, event: { type: "tool/call", seq: ++seq, data: { callId: "call-1", name: "bash", arguments: "{\\"command\\":\\"ls\\"}" } } });
    notify("session.event", { sessionId, event: { type: "tool/result", seq: ++seq, data: { message: { content: "ok" } } } });
    notify("session.event", { sessionId, event: { type: "assistant/message", seq: ++seq, data: { message: { content: "done" }, usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 2 } } } });
    notify("session.event", { sessionId, event: { type: "turn/end", seq: ++seq, data: { turn: 1, reason: { kind: "completed" } } } });
    notify("session.status", { sessionId, status: "idle" });
    return;
  }
  if (msg.method === "shutdown") {
    reply({});
    process.exit(0);
  }
});
`;

const runtime = process.env.DEEPSEEK_SPIKE_RUNTIME;
if (runtime) await runAgainstRuntime(runtime);
else await runAgainstMock();
