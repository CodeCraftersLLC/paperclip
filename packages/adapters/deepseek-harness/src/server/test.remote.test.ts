import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const prepareMock = vi.hoisted(() => vi.fn());
const runProcessMock = vi.hoisted(() => vi.fn());
const restoreMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: prepareMock,
    runAdapterExecutionTargetProcess: runProcessMock,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
  };
});

import { testEnvironment } from "./test.js";

describe("deepseek remote environment diagnostics", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stages the JSON-RPC bridge and probes hello on the remote target", async () => {
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
      await options.onLog(
        "stdout",
        `${JSON.stringify({
          paperclipDeepseek: 1,
          kind: "bridge-result",
          sessionId: options.env.DSH_SESSION_ID,
          summary: "hello",
        })}\n`,
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      };
    });

    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: "/remote/workspace",
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "deepseek_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
        env: { DEEPSEEK_API_KEY: "test-key" },
      },
      executionTarget: remoteTarget,
      environmentName: "QA sandbox",
    });

    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) => check.code === "target" && check.message.includes("QA sandbox"))).toBe(true);
    expect(result.checks.some((check) => check.code === "hello_probe" && check.level === "info")).toBe(true);
    expect(prepareMock).toHaveBeenCalledTimes(1);
    const prepareInput = prepareMock.mock.calls[0]?.[0] as { adapterKey?: string; assets?: Array<{ key: string }> };
    expect(prepareInput.adapterKey).toBe("deepseek");
    expect(prepareInput.assets?.map((asset) => asset.key).sort()).toEqual(["bridge", "cordis", "sessions"]);
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });
});
