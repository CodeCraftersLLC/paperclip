#!/usr/bin/env node
/**
 * One-shot JSON-RPC driver for remote/SSH/sandbox targets.
 * Paperclip's execution-target process API only supplies one-shot stdin, so this
 * process owns the duplex JSON-RPC conversation and prints paperclipDeepseek
 * JSONL (plus a final bridge-result) on stdout.
 *
 * Prompt: stdin
 * Runtime: DSH_JSONRPC_COMMAND + optional DSH_JSONRPC_ARGS (JSON array)
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

const command = (process.env.DSH_JSONRPC_COMMAND ?? "dsh-jsonrpc-agent").trim();
const args = parseJsonArgs(process.env.DSH_JSONRPC_ARGS);
const cwd = (process.env.DSH_CWD ?? process.cwd()).trim() || process.cwd();
const sessionId = (process.env.DSH_SESSION_ID ?? `paperclip-dsh-${Date.now()}`).trim();
const model = (process.env.DSH_MODEL ?? "deepseek-v4-flash").trim();
const provider = (process.env.DSH_PROVIDER ?? "deepseek-official").trim();
const timeoutMs = Math.max(1_000, Number(process.env.DSH_TIMEOUT_MS ?? 30 * 60 * 1000) || 30 * 60 * 1000);
const maxTokens = Number(process.env.DSH_MAX_TOKENS ?? 0) || 0;

const prompt = await readStdin();
if (!prompt.trim()) {
  writeBridgeResult({ errorMessage: "DeepSeek remote bridge received an empty prompt" });
  process.exit(1);
}

const child = spawn(command, args, {
  cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

const client = createNdjsonClient(child);
const notifications = [];
const sessionParents = new Map();

function emitNotification(notification) {
  notifications.push(notification);
  writeLine({ paperclipDeepseek: 1, method: notification.method, params: notification.params });
}

try {
  await request(client, "initialize", {
    cwd,
    provider,
    model,
    ...(maxTokens > 0 ? { maxTokens } : {}),
  }, 15_000);

  const result = await request(client, "session/prompt", {
    sessionId,
    contentBlocks: [{ type: "text", text: prompt }],
  }, 15_000);
  const messageId = result && typeof result.messageId === "string" ? result.messageId : "";
  if (!messageId) throw new Error(`session/prompt did not return messageId: ${JSON.stringify(result)}`);

  await waitForPromptTurn({
    client,
    sessionId,
    messageId,
    timeoutMs,
    sessionParents,
    onNotification: emitNotification,
  });

  try {
    await Promise.race([request(client, "shutdown", {}, 2_000), sleep(1_000)]);
  } catch {
    // Process kill is the cancel story.
  }
  child.stdin.end();
  await Promise.race([once(child, "exit"), sleep(2_000)]);
  writeBridgeResult(parseNotifications(notifications, sessionId));
  client.close();
  process.exit(0);
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  writeBridgeResult({ ...parseNotifications(notifications, sessionId), errorMessage });
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  client.close();
  process.exit(/unknown session/i.test(errorMessage) ? 0 : 1);
}

function parseJsonArgs(raw) {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function writeLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeBridgeResult(result) {
  writeLine({ paperclipDeepseek: 1, kind: "bridge-result", ...result });
}

function createNdjsonClient(child) {
  let nextId = 1;
  const pending = new Map();
  const waiters = [];
  const queue = [];
  let closed = false;
  let failure = null;
  const rl = createInterface({ input: child.stdout });

  function fail(error) {
    if (failure || closed) return;
    failure = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    for (const waiter of waiters) waiter.reject(error);
    waiters.length = 0;
  }

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message.id != null && (message.result !== undefined || message.error)) {
      const waiter = pending.get(Number(message.id));
      if (!waiter) return;
      pending.delete(Number(message.id));
      if (message.error) {
        waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const notification = {
      method: message.method,
      params: message.params && typeof message.params === "object" ? message.params : {},
    };
    if (waiters.length > 0) waiters.shift().resolve(notification);
    else queue.push(notification);
  });
  rl.on("close", () => fail(new Error("DeepSeek Harness JSON-RPC stdout closed")));
  child.on("error", fail);

  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error("JSON-RPC client is closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error) {
            pending.delete(id);
            reject(error);
          }
        });
      });
    },
    async next() {
      if (failure) throw failure;
      if (queue.length > 0) return queue.shift();
      return new Promise((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        waiters.push({ resolve, reject });
      });
    },
    tryNext() {
      if (failure) throw failure;
      return queue.shift() ?? null;
    },
    close() {
      if (closed) return;
      closed = true;
      rl.close();
      const error = new Error("JSON-RPC client closed");
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      for (const waiter of waiters) waiter.reject(error);
      waiters.length = 0;
    },
  };
}

async function request(client, method, params, timeoutMsValue) {
  const pending = client.request(method, params);
  const timeout = timeoutReject(timeoutMsValue, `${method} timed out`);
  try {
    return await Promise.race([pending, timeout.promise]);
  } finally {
    timeout.cancel();
    void pending.catch(() => {});
  }
}

async function waitForPromptTurn(input) {
  let received = false;
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        received
          ? `timed out waiting for session.status idle after inbox receipt ${input.messageId}`
          : `timed out waiting for agent/inbox/spliced receipt ${input.messageId}`,
      );
    }
    const notification = await nextWithTimeout(input.client, remaining);
    if (!isInSessionTree(notification, input.sessionId, input.sessionParents)) continue;
    recordSessionRelationship(notification, input.sessionParents);
    if (!received) {
      if (
        notification.method !== "session.event" ||
        notification.params.sessionId !== input.sessionId ||
        !isInboxReceipt(notification.params.event, input.messageId)
      ) {
        continue;
      }
      received = true;
    }
    input.onNotification(notification);
    if (
      notification.method === "session.status" &&
      notification.params.sessionId === input.sessionId &&
      notification.params.status === "idle"
    ) {
      return;
    }
  }
}

async function nextWithTimeout(client, timeoutMsValue) {
  const queued = client.tryNext();
  if (queued) return queued;
  const pending = client.next();
  const timeout = timeoutReject(timeoutMsValue, "timed out waiting for JSON-RPC notification");
  try {
    return await Promise.race([pending, timeout.promise]);
  } finally {
    timeout.cancel();
    void pending.catch(() => {});
  }
}

function timeoutReject(ms, message) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return {
    promise,
    cancel() {
      clearTimeout(timer);
    },
  };
}

function isInboxReceipt(event, messageId) {
  return Boolean(
    event &&
      event.type === "agent/inbox/spliced" &&
      Array.isArray(event.data?.inserted) &&
      event.data.inserted.some((message) => message && message.id === messageId),
  );
}

function recordSessionRelationship(notification, sessionParents) {
  if (notification.method !== "subagent.started") return;
  const parentId = notification.params.parentSessionId;
  const childId = notification.params.childSessionId;
  if (typeof parentId === "string" && typeof childId === "string" && parentId && childId && parentId !== childId) {
    sessionParents.set(childId, parentId);
  }
}

function isInSessionTree(notification, rootSessionId, sessionParents) {
  if (
    notification.method === "subagent.started" ||
    notification.method === "subagent.finished"
  ) {
    const parentId = notification.params.parentSessionId;
    if (typeof parentId === "string" && isDescendantOf(parentId, rootSessionId, sessionParents)) return true;
    return notification.params.childSessionId === rootSessionId;
  }
  const relatedId = notification.params.sessionId;
  return typeof relatedId === "string" && isDescendantOf(relatedId, rootSessionId, sessionParents);
}

function isDescendantOf(sessionId, rootSessionId, sessionParents) {
  const visited = new Set();
  let current = sessionId;
  while (current) {
    if (current === rootSessionId) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = sessionParents.get(current) ?? "";
  }
  return false;
}

function parseNotifications(items, usedSessionId) {
  let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let chunkUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let sawMessageUsage = false;
  let summary = null;
  let toolName = null;
  let errorMessage = null;
  for (const notification of items) {
    if (notification.method !== "session.event") continue;
    const event = notification.params.event;
    if (!event || typeof event !== "object") continue;
    if (event.type === "assistant/message" && event.data?.usage) {
      usage = addUsage(usage, mapUsage(event.data.usage));
      sawMessageUsage = true;
    }
    if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
      chunkUsage = addUsage(chunkUsage, mapUsage(event.data.chunk.usage));
    }
    if (event.type === "assistant/message") {
      const content = event.data?.message?.content ?? event.data?.content;
      const text = textFromBlocks(content);
      if (text) summary = text;
    }
    if (event.type === "tool/call" && typeof event.data?.name === "string") {
      toolName = event.data.name;
    }
    if (event.type === "turn/end" && event.data?.reason?.kind === "error") {
      errorMessage = event.data.reason.error?.message || "DeepSeek Harness turn ended with an error";
    } else if (event.type === "turn/end" && event.data?.reason?.kind === "max-tokens") {
      errorMessage = "DeepSeek Harness turn ended: max-tokens";
    }
  }
  return {
    sessionId: usedSessionId,
    usage: sawMessageUsage ? usage : chunkUsage,
    summary,
    toolName,
    errorMessage,
  };
}

function mapUsage(usage) {
  return {
    inputTokens: Number(usage?.inputTokens ?? 0),
    outputTokens: Number(usage?.outputTokens ?? 0),
    cachedInputTokens: Number(usage?.cacheReadTokens ?? 0),
  };
}

function addUsage(left, right) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  };
}

function textFromBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
