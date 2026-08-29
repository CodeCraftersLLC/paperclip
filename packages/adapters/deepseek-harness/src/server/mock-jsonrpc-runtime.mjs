import { createInterface } from "node:readline";

const serverInfo = { name: "deepseek-harness-sdk-runtime", version: "0.1.1-rc.2" };
const mode = process.env.DSH_MOCK_MODE ?? "ok";
let seq = 0;

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function error(id, message) {
  write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function emitTurn(sessionId, messageId) {
  if (mode === "idle-before-inbox") {
    notify("session.status", { sessionId, status: "idle" });
  }
  notify("session.event", {
    sessionId,
    event: {
      type: "agent/inbox/spliced",
      data: { inserted: [{ id: messageId }] },
    },
  });
  notify("session.event", {
    sessionId,
    event: { type: "tool/call", data: { name: "bash", callId: `call-${messageId}` } },
  });
  notify("session.event", {
    sessionId,
    event: {
      type: "assistant/message",
      data: {
        message: { content: [{ type: "text", text: `ack ${messageId}` }] },
        usage: { inputTokens: 22, outputTokens: 8, cacheReadTokens: 4 },
      },
    },
  });
  notify("session.status", { sessionId, status: "idle" });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    reply(msg.id, { serverInfo });
    return;
  }
  if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    if (mode === "unknown-session" || sessionId.startsWith("stale")) {
      error(msg.id, `unknown session ${sessionId}`);
      return;
    }
    const messageId = `msg-${++seq}`;
    reply(msg.id, { messageId });
    queueMicrotask(() => emitTurn(sessionId, messageId));
    return;
  }
  if (msg.method === "shutdown") {
    reply(msg.id, {});
    rl.close();
    process.exit(0);
  }
});
