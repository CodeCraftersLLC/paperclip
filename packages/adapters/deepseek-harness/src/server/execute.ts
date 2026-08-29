import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetSessionMatches,
  readAdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asStringArray,
  buildInvocationEnvForLogs,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  buildLocalProcessSandboxSpawnTarget,
  parseLocalProcessFilesystemScope,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  parseLocalProcessSandboxExtraPaths,
  type LocalProcessSandboxOptions,
} from "@paperclipai/adapter-utils/local-process-sandbox";
import { ADAPTER_TYPE } from "../shared/constants.js";
import { classifyDeepseekError, isUnknownSessionError } from "./protocol.js";
import { parseTurnNotifications } from "./parse.js";
import { canResumeDeepseekSession } from "./session.js";
import {
  formatRpcError,
  initializeRuntime,
  mintSessionId,
  promptAndWait,
  spawnDeepseekRuntime,
} from "./jsonrpc-runtime.js";
import { resolveDeepseekExecuteSetup } from "./execute-setup.js";
import { executeRemote } from "./execute-remote.js";
import type { JsonRpcNotification } from "./jsonrpc-client.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runtime, config, onLog, onMeta, onSpawn } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const preliminary = await resolveDeepseekExecuteSetup(ctx, {
    sessionId: mintSessionId(),
    canResume: false,
  });
  const savedRemoteExecution = parseObject(
    (runtime.sessionParams && typeof runtime.sessionParams === "object"
      ? (runtime.sessionParams as Record<string, unknown>).remoteExecution
      : null),
  );
  const canResume =
    preliminary.persist &&
    canResumeDeepseekSession({
      sessionId: preliminary.savedSessionId || null,
      savedCwd: executionTargetIsRemote ? null : preliminary.savedCwd || null,
      savedSessionRoot: preliminary.savedSessionRoot || null,
      cwd: preliminary.cwd,
      sessionRoot: preliminary.sessionRoot,
    }) &&
    (executionTargetIsRemote
      ? adapterExecutionTargetSessionMatches(savedRemoteExecution, executionTarget)
      : Object.keys(savedRemoteExecution).length === 0);
  const sessionId = canResume && preliminary.savedSessionId ? preliminary.savedSessionId : mintSessionId();
  const setup = canResume
    ? await resolveDeepseekExecuteSetup(ctx, { sessionId, canResume: true })
    : { ...preliminary, sessionId };
  setup.extraArgs = asStringArray(config.extraArgs);

  if (preliminary.savedSessionId && !canResume) {
    await onLog(
      "stdout",
      `[paperclip] DeepSeek session "${preliminary.savedSessionId}" does not match cwd/sessionRoot/target and will not be resumed.\n`,
    );
  }

  if (executionTargetIsRemote && executionTarget) {
    return executeRemote({ ctx, setup, executionTarget });
  }

  if (onMeta) {
    await onMeta({
      adapterType: ADAPTER_TYPE,
      command: setup.command,
      cwd: setup.cwd,
      commandNotes: [
        "Drives DeepSeek Harness over JSON-RPC stdio (initialize + session/prompt).",
        `Cordis config: ${setup.cordisConfigPath}`,
        setup.harnessRoot
          ? `Harness root / NODE_PATH: ${setup.harnessRoot}`
          : "No harnessRoot set; plugins must resolve from the configuration project.",
        "Do not add a stdout logger to the Cordis composition.",
      ],
      env: buildInvocationEnvForLogs(setup.env, {
        runtimeEnv: Object.fromEntries(
          Object.entries({ ...process.env, ...setup.env }).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      }),
      prompt: setup.prompt,
      promptMetrics: {
        promptChars: setup.prompt.length,
        wakePromptChars: setup.wakePrompt.length,
        heartbeatPromptChars: setup.renderedPrompt.length,
      },
      context: { sessionId: setup.sessionId, sessionRoot: setup.sessionRoot, model: setup.model, provider: setup.provider },
    });
  }

  const filesystemScope = parseLocalProcessFilesystemScope(config.filesystemScope);
  const networkScope = parseLocalProcessNetworkScope(config.networkScope);
  let command = setup.command;
  let args = setup.extraArgs;
  let cwd = setup.cwd;
  const runtimeEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...setup.env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  let sandboxCleanup: (() => Promise<void>) | undefined;
  if (filesystemScope || networkScope) {
    const localProcessSandbox: LocalProcessSandboxOptions = {
      workspaceDir: setup.cwd,
      filesystemScope,
      extraPaths: parseLocalProcessSandboxExtraPaths(config.filesystemExtraPaths),
      homeDir: filesystemScope ? setup.sessionRoot : null,
      networkScope,
      networkAllowlist: parseLocalProcessNetworkAllowlist(config.networkAllowlist),
      command: typeof config.filesystemSandboxCommand === "string" ? config.filesystemSandboxCommand : "bwrap",
    };
    const scopes = [filesystemScope ? "workspace filesystem" : null, networkScope ? `${networkScope} network` : null]
      .filter(Boolean)
      .join(" and ");
    await onLog("stdout", `[paperclip] Confining DeepSeek Harness with ${scopes} scope.\n`);
    const sandboxed = await buildLocalProcessSandboxSpawnTarget({
      executable: command,
      args,
      cwd,
      options: localProcessSandbox,
    });
    command = sandboxed.command;
    args = sandboxed.args;
    cwd = sandboxed.cwd;
    Object.assign(runtimeEnv, sandboxed.env);
    sandboxCleanup = sandboxed.cleanup;
  }

  const runtimeHandle = await spawnDeepseekRuntime({
    command,
    args,
    cwd,
    env: runtimeEnv,
    onStderr: (chunk) => onLog("stderr", chunk),
    onSpawn,
  });

  const emitNotification = async (notification: JsonRpcNotification) => {
    await onLog("stdout", `${JSON.stringify({ paperclipDeepseek: 1, ...notification })}\n`);
  };

  try {
    await initializeRuntime(runtimeHandle.client, {
      cwd: setup.cwd,
      provider: setup.provider,
      model: setup.model,
      ...(setup.maxTokens > 0 ? { maxTokens: setup.maxTokens } : {}),
    });

    const runPrompt = async (id: string) =>
      promptAndWait({
        client: runtimeHandle.client,
        sessionId: id,
        prompt: setup.prompt,
        timeoutMs: setup.timeoutMs,
        onNotification: emitNotification,
      });

    try {
      const turn = await runPrompt(setup.sessionId);
      const parsed = parseTurnNotifications(turn.notifications);
      if (parsed.unknownSession) {
        const retryId = mintSessionId();
        await onLog("stdout", `[paperclip] DeepSeek session was unknown; retrying with a fresh session.\n`);
        const retry = await runPrompt(retryId);
        const retryParsed = parseTurnNotifications(retry.notifications);
        const closed = await runtimeHandle.close(setup.graceSec * 1000);
        return buildResult({
          sessionId: retryId,
          cwd: setup.cwd,
          sessionRoot: setup.sessionRoot,
          model: setup.model,
          persist: setup.persist,
          parsed: retryParsed,
          exitCode: closed.exitCode ?? (retryParsed.errorMessage ? 1 : 0),
          signal: closed.signal,
          timedOut: false,
          clearSession: true,
        });
      }
      const closed = await runtimeHandle.close(setup.graceSec * 1000);
      return buildResult({
        sessionId: setup.sessionId,
        cwd: setup.cwd,
        sessionRoot: setup.sessionRoot,
        model: setup.model,
        persist: setup.persist,
        parsed,
        exitCode: closed.exitCode ?? (parsed.errorMessage ? 1 : 0),
        signal: closed.signal,
        timedOut: false,
        clearSession: false,
      });
    } catch (error) {
      const message = formatRpcError(error);
      if (isUnknownSessionError(message)) {
        const retryId = mintSessionId();
        await onLog("stdout", `[paperclip] DeepSeek session was unknown; retrying with a fresh session.\n`);
        try {
          const retry = await runPrompt(retryId);
          const retryParsed = parseTurnNotifications(retry.notifications);
          const closed = await runtimeHandle.close(setup.graceSec * 1000);
          return buildResult({
            sessionId: retryId,
            cwd: setup.cwd,
            sessionRoot: setup.sessionRoot,
            model: setup.model,
            persist: setup.persist,
            parsed: retryParsed,
            exitCode: closed.exitCode ?? (retryParsed.errorMessage ? 1 : 0),
            signal: closed.signal,
            timedOut: false,
            clearSession: true,
          });
        } catch (retryError) {
          const retryMessage = formatRpcError(retryError);
          const closed = await runtimeHandle.close(setup.graceSec * 1000);
          return {
            exitCode: closed.exitCode ?? 1,
            signal: closed.signal,
            timedOut: /timed out/i.test(retryMessage),
            errorMessage: retryMessage,
            errorFamily: classifyDeepseekError(retryMessage),
            clearSession: true,
            provider: "deepseek",
            model: setup.model,
            usageBasis: "per_run",
          };
        }
      }
      const timedOut = /timed out/i.test(message);
      const closed = await runtimeHandle.close(setup.graceSec * 1000);
      return {
        exitCode: timedOut ? null : (closed.exitCode ?? 1),
        signal: closed.signal,
        timedOut,
        errorMessage: message,
        errorFamily: classifyDeepseekError(message),
        clearSession: false,
        provider: "deepseek",
        model: setup.model,
        usageBasis: "per_run",
        ...(setup.persist
          ? {
              sessionId: setup.sessionId,
              sessionParams: {
                sessionId: setup.sessionId,
                cwd: setup.cwd,
                sessionRoot: setup.sessionRoot,
              },
              sessionDisplayId: setup.sessionId,
            }
          : {}),
      };
    }
  } catch (error) {
    const errorMessage = formatRpcError(error);
    const closed = await runtimeHandle.close(setup.graceSec * 1000);
    return {
      exitCode: closed.exitCode ?? 1,
      signal: closed.signal,
      timedOut: false,
      errorMessage,
      errorFamily: classifyDeepseekError(errorMessage),
      provider: "deepseek",
      model: setup.model,
      usageBasis: "per_run",
    };
  } finally {
    await sandboxCleanup?.().catch(() => undefined);
  }
}

function buildResult(input: {
  sessionId: string;
  cwd: string;
  sessionRoot: string;
  model: string;
  persist: boolean;
  parsed: ReturnType<typeof parseTurnNotifications>;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  clearSession: boolean;
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
          },
          sessionDisplayId: input.sessionId,
        }
      : {}),
  };
}
