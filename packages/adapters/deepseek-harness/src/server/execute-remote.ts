import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  adapterExecutionTargetDuplexTelemetryRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asStringArray,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
} from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE } from "../shared/constants.js";
import { classifyDeepseekError, isUnknownSessionError } from "./protocol.js";
import { parseBridgeStdout, parseTurnNotifications, type DeepseekTurnParse } from "./parse.js";
import { formatRpcError, mintSessionId } from "./jsonrpc-runtime.js";
import { resolveDeepseekRemoteBridgePath } from "./remote-bridge-path.js";
import { restoreDeepseekSessionExport, SESSION_EXPORT_FILENAME } from "./session-export.js";
import type { DeepseekExecuteSetup } from "./execute-setup.js";

export async function executeRemote(input: {
  ctx: AdapterExecutionContext;
  setup: DeepseekExecuteSetup;
  executionTarget: AdapterExecutionTarget;
}): Promise<AdapterExecutionResult> {
  const { ctx, setup } = input;
  const { runId, config, onLog, onMeta, onSpawn } = ctx;
  const extraArgs = asStringArray(config.extraArgs);
  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let stageDir: string | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  let result: AdapterExecutionResult | null = null;

  try {
    await onLog(
      "stdout",
      `[paperclip] Syncing DeepSeek workspace and runtime assets to ${describeAdapterExecutionTarget(input.executionTarget)}.\n`,
    );

    stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dsh-remote-"));
    const cordisDir = path.join(stageDir, "cordis");
    const bridgeDir = path.join(stageDir, "bridge");
    await fs.mkdir(cordisDir, { recursive: true });
    await fs.mkdir(bridgeDir, { recursive: true });
    await fs.copyFile(setup.cordisConfigPath, path.join(cordisDir, "paperclip.cordis.yml"));
    await fs.copyFile(resolveDeepseekRemoteBridgePath(), path.join(bridgeDir, "remote-bridge.mjs"));

    const prepared = await prepareAdapterExecutionTargetRuntime({
      runId,
      target: input.executionTarget,
      adapterKey: "deepseek",
      workspaceLocalDir: setup.cwd,
      timeoutSec: setup.timeoutSec,
      installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? setup.command,
      onProgress: (line) => onLog("stdout", line),
      onRuntimeProgress: ctx.onRuntimeProgress,
      assets: [
        { key: "cordis", localDir: cordisDir },
        { key: "bridge", localDir: bridgeDir },
        {
          key: "sessions",
          localDir: setup.sessionRoot,
          restore: async ({ assetDir, readFile }) => {
            try {
              const exportBytes = await readFile(path.posix.join(assetDir, SESSION_EXPORT_FILENAME));
              const restored = await restoreDeepseekSessionExport({
                localSessionRoot: setup.sessionRoot,
                exportBytes,
              });
              if (restored > 0) {
                await onLog(
                  "stdout",
                  `[paperclip] Restored ${restored} DeepSeek session file(s) from the remote target.\n`,
                );
              }
            } catch (error) {
              const err = error as NodeJS.ErrnoException;
              if (err.code === "ENOENT") return;
              throw error;
            }
          },
        },
        ...(setup.skillsDir
          ? [{ key: "skills", localDir: setup.skillsDir, followSymlinks: true }]
          : []),
      ],
    });
    restoreRemoteWorkspace = () => prepared.restoreWorkspace((line) => onLog("stdout", line));

    const effectiveExecutionCwd = prepared.workspaceRemoteDir ?? setup.cwd;
    refreshPaperclipWorkspaceEnvForExecution({
      env: setup.env,
      envConfig: setup.envConfig,
      workspaceCwd: setup.workspaceCwd,
      workspaceSource: setup.workspaceSource,
      workspaceId: setup.workspaceId,
      workspaceRepoUrl: setup.workspaceRepoUrl,
      workspaceRepoRef: setup.workspaceRepoRef,
      workspaceHints: setup.workspaceHints,
      agentHome: setup.agentHome,
      executionTargetIsRemote: true,
      executionCwd: effectiveExecutionCwd,
    });

    if (adapterExecutionTargetUsesManagedHome(input.executionTarget) && prepared.runtimeRootDir) {
      setup.env.HOME = prepared.runtimeRootDir;
    }

    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(
      input.executionTarget,
      effectiveExecutionCwd,
    );
    const remoteSessionIdentity = adapterExecutionTargetSessionIdentity(runtimeExecutionTarget);
    const remoteCordis = prepared.assetDirs.cordis
      ? path.posix.join(prepared.assetDirs.cordis, "paperclip.cordis.yml")
      : setup.cordisConfigPath;
    const remoteBridge = prepared.assetDirs.bridge
      ? path.posix.join(prepared.assetDirs.bridge, "remote-bridge.mjs")
      : resolveDeepseekRemoteBridgePath();
    const remoteSessions = prepared.assetDirs.sessions ?? setup.sessionRoot;
    const remoteSkills = prepared.assetDirs.skills ?? setup.skillsDir;

    setup.env.DSH_CWD = effectiveExecutionCwd;
    setup.env.DSH_SESSION_ROOT = remoteSessions;
    setup.env.DSH_CORDIS_CONFIG = remoteCordis;
    setup.env.DSH_MODEL = setup.model;
    setup.env.DSH_PROVIDER = setup.provider;
    setup.env.DSH_JSONRPC_COMMAND = setup.command;
    if (extraArgs.length > 0) setup.env.DSH_JSONRPC_ARGS = JSON.stringify(extraArgs);
    if (remoteSkills) setup.env.DSH_BUNDLED_SKILL_DIR = remoteSkills;
    if (setup.maxTokens > 0) setup.env.DSH_MAX_TOKENS = String(setup.maxTokens);

    if (adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexTelemetryRecorder: adapterExecutionTargetDuplexTelemetryRecorder(runtimeExecutionTarget),
        runtimeRootDir: prepared.runtimeRootDir,
        adapterKey: "deepseek",
        timeoutSec: setup.timeoutSec,
        hostApiToken: setup.env.PAPERCLIP_API_KEY,
      });
      if (paperclipBridge) Object.assign(setup.env, paperclipBridge.env);
    }

    const runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv({ ...process.env, ...setup.env })).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: runtimeExecutionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? setup.command,
      cwd: setup.cwd,
      env: runtimeEnv,
      timeoutSec: setup.timeoutSec,
      graceSec: setup.graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(
      setup.command,
      runtimeExecutionTarget,
      setup.cwd,
      runtimeEnv,
    );
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
      setup.command,
      runtimeExecutionTarget,
      setup.cwd,
      runtimeEnv,
    );

    if (onMeta) {
      await onMeta({
        adapterType: ADAPTER_TYPE,
        command: `node ${remoteBridge}`,
        cwd: effectiveExecutionCwd,
        commandNotes: [
          "Remote DeepSeek runs use a one-shot JSON-RPC bridge because execution targets only accept one-shot stdin.",
          `Inner runtime: ${resolvedCommand}`,
          `Cordis config: ${remoteCordis}`,
          "installCommand is null; the remote host must already have dsh-jsonrpc-agent and harness plugins.",
        ],
        env: buildInvocationEnvForLogs(setup.env, { runtimeEnv }),
        prompt: setup.prompt,
        promptMetrics: {
          promptChars: setup.prompt.length,
          wakePromptChars: setup.wakePrompt.length,
          heartbeatPromptChars: setup.renderedPrompt.length,
        },
        context: {
          sessionId: setup.sessionId,
          sessionRoot: remoteSessions,
          model: setup.model,
          provider: setup.provider,
        },
      });
    }

    const runTurn = async (sessionId: string) => {
      setup.env.DSH_SESSION_ID = sessionId;
      setup.env.DSH_TIMEOUT_MS = String(setup.timeoutMs);
      const turnEnv = Object.fromEntries(
        Object.entries(ensurePathInEnv({ ...process.env, ...setup.env })).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      let stdout = "";
      const result = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, "node", [remoteBridge], {
        cwd: effectiveExecutionCwd,
        env: turnEnv,
        stdin: setup.prompt,
        timeoutSec: setup.timeoutSec,
        graceSec: setup.graceSec,
        onLog: async (stream, chunk) => {
          if (stream === "stdout") stdout += chunk;
          await onLog(stream, chunk);
        },
        onRuntimeProgress: ctx.onRuntimeProgress,
        onSpawn,
      });
      const parsed = parseBridgeStdout(stdout);
      return { result, parsed };
    };

    let sessionId = setup.sessionId;
    let turn = await runTurn(sessionId);
    let parsed = turn.parsed;
    let clearSession = false;
    if (parsed.unknownSession || isUnknownSessionError(parsed.errorMessage ?? "")) {
      clearSession = true;
      sessionId = mintSessionId();
      await onLog("stdout", `[paperclip] DeepSeek session was unknown; retrying with a fresh session.\n`);
      turn = await runTurn(sessionId);
      parsed = turn.parsed;
    }

    result = buildRemoteResult({
      sessionId,
      cwd: effectiveExecutionCwd,
      sessionRoot: remoteSessions,
      model: setup.model,
      persist: setup.persist,
      parsed,
      exitCode: turn.result.exitCode ?? (parsed.errorMessage ? 1 : 0),
      signal: turn.result.signal,
      timedOut: turn.result.timedOut,
      clearSession,
      remoteExecution: remoteSessionIdentity,
    });
  } catch (error) {
    const errorMessage = formatRpcError(error);
    result = {
      exitCode: 1,
      signal: null,
      timedOut: /timed out/i.test(errorMessage),
      errorMessage,
      errorFamily: classifyDeepseekError(errorMessage),
      provider: "deepseek",
      model: setup.model,
      usageBasis: "per_run",
    };
  } finally {
    await paperclipBridge?.stop?.().catch(() => undefined);
    if (restoreRemoteWorkspace) {
      try {
        await restoreRemoteWorkspace();
      } catch (error) {
        const restoreMessage = `Workspace restore failed: ${formatRpcError(error)}`;
        await onLog("stderr", `[paperclip] ${restoreMessage}\n`);
        if (result) {
          result = {
            ...result,
            exitCode: 1,
            errorMessage: result.errorMessage ?? restoreMessage,
          };
        }
      }
    }
    if (stageDir) {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return result ?? {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: "DeepSeek remote execute produced no result",
    provider: "deepseek",
    model: setup.model,
    usageBasis: "per_run",
  };
}

function buildRemoteResult(input: {
  sessionId: string;
  cwd: string;
  sessionRoot: string;
  model: string;
  persist: boolean;
  parsed: DeepseekTurnParse;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  clearSession: boolean;
  remoteExecution: Record<string, unknown> | null;
}): AdapterExecutionResult {
  return {
    exitCode: input.parsed.errorMessage ? 1 : input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    errorMessage: input.parsed.errorMessage,
    errorFamily: input.parsed.errorFamily,
    usage: input.parsed.usage,
    usageBasis: "per_run",
    provider: "deepseek",
    model: input.model,
    summary: input.parsed.summary,
    clearSession: input.clearSession,
    ...(input.persist
      ? {
          sessionId: input.sessionId,
          sessionParams: {
            sessionId: input.sessionId,
            cwd: input.cwd,
            sessionRoot: input.sessionRoot,
            ...(input.remoteExecution ? { remoteExecution: input.remoteExecution } : {}),
          },
          sessionDisplayId: input.sessionId,
        }
      : {}),
  };
}
