import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { JsonRpcNdjsonClient, JsonRpcResponseError } from "./jsonrpc-client.js";
import {
  PROTOCOL_METHODS,
  isRecord,
  type InitializeParams,
  type SessionPromptResult,
} from "./protocol.js";
import { waitForPromptTurn } from "./wait-for-turn.js";
import type { JsonRpcNotification } from "./jsonrpc-client.js";

export interface SpawnedDeepseekRuntime {
  child: ChildProcessWithoutNullStreams;
  client: JsonRpcNdjsonClient;
  stderr: string;
  close: (graceMs: number) => Promise<{ exitCode: number | null; signal: string | null }>;
}

export async function spawnDeepseekRuntime(input: {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStderr?: (chunk: string) => void | Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
}): Promise<SpawnedDeepseekRuntime> {
  const child = spawn(input.command, input.args ?? [], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });

  if (input.onSpawn && child.pid) {
    await input.onSpawn({
      pid: child.pid,
      processGroupId: typeof child.pid === "number" ? child.pid : null,
      startedAt: new Date().toISOString(),
    });
  }

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    void input.onStderr?.(text);
  });

  const client = new JsonRpcNdjsonClient(child.stdin, child.stdout);

  const close = async (graceMs: number) => {
    try {
      await Promise.race([
        client.request(PROTOCOL_METHODS.shutdown, {}),
        sleep(1_000),
      ]);
    } catch {
      // Process kill is the cancel story; shutdown is best-effort.
    }
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    client.close();
    if (child.exitCode !== null || child.signalCode) {
      return { exitCode: child.exitCode, signal: child.signalCode };
    }
    child.kill("SIGTERM");
    const first = await waitForExit(child, graceMs);
    if (first) return first;
    child.kill("SIGKILL");
    return (await waitForExit(child, 2_000)) ?? { exitCode: child.exitCode, signal: child.signalCode };
  };

  return { child, client, stderr, close };
}

export async function initializeRuntime(
  client: JsonRpcNdjsonClient,
  params: InitializeParams,
): Promise<void> {
  const result = await client.request(PROTOCOL_METHODS.initialize, params);
  if (!isRecord(result)) return;
  const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : null;
  if (serverInfo && typeof serverInfo.name === "string" && serverInfo.name !== "deepseek-harness-sdk-runtime") {
    throw new Error(`Unexpected DeepSeek JSON-RPC serverInfo.name: ${serverInfo.name}`);
  }
}

export async function promptAndWait(input: {
  client: JsonRpcNdjsonClient;
  sessionId: string;
  prompt: string;
  timeoutMs: number;
  onNotification?: (notification: JsonRpcNotification) => void | Promise<void>;
}): Promise<{ messageId: string; notifications: JsonRpcNotification[] }> {
  const subscription = input.client.subscribeSessionTree(input.sessionId);
  try {
    const result = await input.client.request(PROTOCOL_METHODS.prompt, {
      sessionId: input.sessionId,
      contentBlocks: [{ type: "text", text: input.prompt }],
    });
    const messageId = readMessageId(result);
    const notifications = await waitForPromptTurn(subscription, {
      sessionId: input.sessionId,
      messageId,
      timeoutMs: input.timeoutMs,
      onNotification: input.onNotification,
    });
    return { messageId, notifications };
  } finally {
    subscription.close();
  }
}

export function mintSessionId(): string {
  return `paperclip-dsh-${randomUUID()}`;
}

export function formatRpcError(error: unknown): string {
  if (error instanceof JsonRpcResponseError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function readMessageId(result: unknown): string {
  if (isRecord(result) && typeof result.messageId === "string" && result.messageId.trim()) {
    return result.messageId;
  }
  throw new Error(`session/prompt did not return messageId: ${JSON.stringify(result)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  ms: number,
): Promise<{ exitCode: number | null; signal: string | null } | null> {
  if (child.exitCode !== null || child.signalCode) {
    return Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(null);
    }, ms);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal });
    };
    child.once("exit", onExit);
  });
}

export type { SessionPromptResult };
