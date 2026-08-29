import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const mockRuntime = fileURLToPath(new URL("./mock-jsonrpc-runtime.mjs", import.meta.url));
const tempDirs: string[] = [];
const originalHome = process.env.PAPERCLIP_HOME;

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-home-"));
  tempDirs.push(home);
  process.env.PAPERCLIP_HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalHome;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeCtx(overrides: {
  sessionParams?: Record<string, unknown> | null;
  cwd?: string;
  extra?: Record<string, unknown>;
} = {}): Promise<AdapterExecutionContext> {
  const cwd = overrides.cwd ?? await fs.mkdtemp(path.join(os.tmpdir(), "dsh-exec-"));
  tempDirs.push(cwd);
  const logs: string[] = [];
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "DeepSeek",
      adapterType: "deepseek_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: overrides.sessionParams ?? null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: process.execPath,
      extraArgs: [mockRuntime],
      cwd,
      persistSession: true,
      timeoutSec: 10,
      graceSec: 2,
      env: { DEEPSEEK_API_KEY: "test-key" },
      ...overrides.extra,
    },
    context: {},
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
    logs,
  } as AdapterExecutionContext & { logs: string[] };
}

describe("execute", () => {
  it("completes a JSON-RPC turn and persists sessionId/cwd/sessionRoot", async () => {
    const ctx = await makeCtx();
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 8, cachedInputTokens: 4 });
    expect(result.usageBasis).toBe("per_run");
    expect(result.summary).toMatch(/^ack /);
    expect(result.sessionId).toMatch(/^paperclip-dsh-/);
    expect(result.sessionParams).toMatchObject({
      sessionId: result.sessionId,
      cwd: ctx.config.cwd,
    });
    expect(result.sessionParams?.sessionRoot).toBe(
      path.join(String(process.env.PAPERCLIP_HOME), "adapter-state", "company-1", "agent-1", "deepseek", "sessions"),
    );
  });

  it("ignores a stale idle notification before inbox receipt", async () => {
    const ctx = await makeCtx({
      extra: { env: { DEEPSEEK_API_KEY: "test-key", DSH_MOCK_MODE: "idle-before-inbox" } },
    });
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 8, cachedInputTokens: 4 });
    expect(result.summary).toMatch(/^ack /);
  });

  it("rejects remote execution targets in Phase 1/2", async () => {
    const ctx = await makeCtx();
    ctx.executionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/remote/workspace",
    } as AdapterExecutionContext["executionTarget"];
    const result = await execute(ctx);
    expect(result.errorCode).toBe("remote_not_implemented");
    expect(result.exitCode).toBe(1);
  });

  it("resumes the same sessionId on a second heartbeat", async () => {
    const firstCtx = await makeCtx();
    const first = await execute(firstCtx);
    const secondCtx = await makeCtx({
      cwd: String(firstCtx.config.cwd),
      sessionParams: first.sessionParams ?? null,
    });
    const second = await execute(secondCtx);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.exitCode).toBe(0);
  });

  it("does not resume when cwd changed", async () => {
    const firstCtx = await makeCtx();
    const first = await execute(firstCtx);
    const secondCtx = await makeCtx({
      sessionParams: first.sessionParams ?? null,
    });
    const second = await execute(secondCtx);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("retries with clearSession when the runtime rejects the session", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-exec-"));
    tempDirs.push(cwd);
    const sessionRoot = path.join(cwd, "sessions");
    await fs.mkdir(sessionRoot, { recursive: true });
    const ctx = await makeCtx({
      cwd,
      sessionParams: { sessionId: "stale-old", cwd, sessionRoot },
      extra: { sessionRoot },
    });
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(true);
    expect(result.sessionId).not.toBe("stale-old");
    expect(result.sessionId).toMatch(/^paperclip-dsh-/);
  });
});
