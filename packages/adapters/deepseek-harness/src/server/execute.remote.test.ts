import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const prepareMock = vi.hoisted(() => vi.fn());
const runProcessMock = vi.hoisted(() => vi.fn());
const restoreMock = vi.hoisted(() => vi.fn(async () => {}));
const bridgeStopMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: prepareMock,
    runAdapterExecutionTargetProcess: runProcessMock,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => {}),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "dsh-jsonrpc-agent"),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
      env: {
        PAPERCLIP_API_URL: "http://127.0.0.1:4310",
        PAPERCLIP_API_KEY: "bridge-token",
      },
      stop: bridgeStopMock,
    })),
  };
});

import { execute } from "./execute.js";

const tempDirs: string[] = [];
const originalHome = process.env.PAPERCLIP_HOME;

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-remote-home-"));
  tempDirs.push(home);
  process.env.PAPERCLIP_HOME = home;
  prepareMock.mockReset();
  runProcessMock.mockReset();
  restoreMock.mockClear();
  bridgeStopMock.mockClear();
  prepareMock.mockResolvedValue({
    workspaceRemoteDir: "/remote/workspace",
    runtimeRootDir: "/remote/runtime",
    assetDirs: {
      cordis: "/remote/assets/cordis",
      bridge: "/remote/assets/bridge",
      sessions: "/remote/assets/sessions",
    },
    restoreWorkspace: restoreMock,
  });
  runProcessMock.mockImplementation(async (_runId, _target, command, args, options) => {
    expect(command).toBe("node");
    expect(args[0]).toBe("/remote/assets/bridge/remote-bridge.mjs");
    const sessionId = options.env.DSH_SESSION_ID;
    await options.onLog(
      "stdout",
      `${JSON.stringify({
        paperclipDeepseek: 1,
        kind: "bridge-result",
        sessionId,
        usage: { inputTokens: 22, outputTokens: 8, cachedInputTokens: 4 },
        summary: "ack remote",
        toolName: "bash",
      })}\n`,
    );
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: 99,
      startedAt: new Date().toISOString(),
    };
  });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalHome;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRemoteCtx(): Promise<AdapterExecutionContext> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-remote-cwd-"));
  tempDirs.push(cwd);
  return {
    runId: "run-remote-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "DeepSeek",
      adapterType: "deepseek_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      cwd,
      persistSession: true,
      timeoutSec: 10,
      graceSec: 2,
      env: { DEEPSEEK_API_KEY: "test-key" },
    },
    context: {},
    executionTarget: {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/remote/workspace",
      providerKey: "fake-plugin",
    },
    onLog: async () => {},
  } as AdapterExecutionContext;
}

describe("execute remote", () => {
  it("prepares assets, runs the JSON-RPC bridge, and restores the workspace", async () => {
    const ctx = await makeRemoteCtx();
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("ack remote");
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 8, cachedInputTokens: 4 });
    expect(result.sessionParams).toMatchObject({
      cwd: "/remote/workspace",
      sessionRoot: "/remote/assets/sessions",
      remoteExecution: {
        transport: "sandbox",
        providerKey: "fake-plugin",
        remoteCwd: "/remote/workspace",
      },
    });
    expect(prepareMock).toHaveBeenCalledTimes(1);
    const prepareInput = prepareMock.mock.calls[0]?.[0] as { assets?: Array<{ key: string }> };
    expect(prepareInput.assets?.map((asset) => asset.key).sort()).toEqual(["bridge", "cordis", "sessions"]);
    const sessionsAsset = (prepareMock.mock.calls[0]?.[0] as {
      assets?: Array<{ key: string; restore?: (ctx: { assetDir: string; readFile: (p: string) => Promise<Buffer> }) => Promise<void> }>;
    }).assets?.find((asset) => asset.key === "sessions");
    const sessionRoot = path.join(String(process.env.PAPERCLIP_HOME), "adapter-state", "company-1", "agent-1", "deepseek", "sessions");
    await sessionsAsset?.restore?.({
      assetDir: "/remote/assets/sessions",
      readFile: async () =>
        Buffer.from(JSON.stringify({
          files: [{ path: "session.json", contents: Buffer.from("{\"ok\":true}", "utf8").toString("base64") }],
        })),
    });
    expect(await fs.readFile(path.join(sessionRoot, "session.json"), "utf8")).toBe("{\"ok\":true}");
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(bridgeStopMock).toHaveBeenCalledTimes(1);
  });

  it("retries the bridge once when the remote session is unknown", async () => {
    runProcessMock
      .mockImplementationOnce(async (_runId, _target, _command, _args, options) => {
        await options.onLog(
          "stdout",
          `${JSON.stringify({
            paperclipDeepseek: 1,
            kind: "bridge-result",
            sessionId: options.env.DSH_SESSION_ID,
            errorMessage: "unknown session stale-old",
          })}\n`,
        );
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: 99,
          startedAt: new Date().toISOString(),
        };
      });
    const ctx = await makeRemoteCtx();
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(true);
    expect(runProcessMock).toHaveBeenCalledTimes(2);
  });
});
