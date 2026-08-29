import fs from "node:fs/promises";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  readAdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE } from "../shared/constants.js";
import { classifyDeepseekError, isUnknownSessionError } from "./protocol.js";
import { parseTurnNotifications } from "./parse.js";
import { canResumeDeepseekSession, sessionCodec } from "./session.js";
import {
  buildRuntimeNodePath,
  persistSessionEnabled,
  resolveCordisConfigPath,
  resolveDeepseekCommand,
  resolveDeepseekModel,
  resolveDeepseekProvider,
  resolveDeepseekSessionRoot,
  resolveGraceSec,
  resolveHarnessRoot,
  resolveTimeoutSec,
} from "./runtime-config.js";
import {
  formatRpcError,
  initializeRuntime,
  mintSessionId,
  promptAndWait,
  spawnDeepseekRuntime,
} from "./jsonrpc-runtime.js";
import { materializeDeepseekSkills, resolveDeepseekSkillsDir } from "./skills.js";
import type { JsonRpcNotification } from "./jsonrpc-client.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (adapterExecutionTargetIsRemote(executionTarget)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "deepseek_local remote/SSH/sandbox execution is not implemented in Phase 1. Use a local execution target.",
      errorCode: "remote_not_implemented",
    };
  }

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const cwd = (useConfiguredInsteadOfAgentHome ? "" : workspaceCwd) || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const wakeTaskId =
    asString(context.taskId, "") || asString(context.issueId, "") || null;
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  const sessionRoot = resolveDeepseekSessionRoot({
    companyId: agent.companyId,
    agentId: agent.id,
    sessionRoot: asString(config.sessionRoot, ""),
  });
  await fs.mkdir(sessionRoot, { recursive: true });
  const skillsDir = resolveDeepseekSkillsDir({ companyId: agent.companyId, agentId: agent.id });
  const stagedSkills = await materializeDeepseekSkills({ config, destDir: skillsDir });
  if (stagedSkills > 0) {
    env.DSH_BUNDLED_SKILL_DIR = skillsDir;
    await onLog("stdout", `[paperclip] Materialized ${stagedSkills} DeepSeek skill(s) into ${skillsDir}\n`);
  }

  const command = resolveDeepseekCommand(config, env);
  const harnessRoot = resolveHarnessRoot(config, env);
  const cordisConfigPath = resolveCordisConfigPath(config, env);
  const model = resolveDeepseekModel(config, env);
  const provider = resolveDeepseekProvider(config);
  const timeoutSec = resolveTimeoutSec(config);
  const graceSec = resolveGraceSec(config);
  const maxTokens = asNumber(config.maxTokens, 0);

  env.DSH_CWD = cwd;
  env.DSH_SESSION_ROOT = sessionRoot;
  env.DSH_MODEL = model;
  env.DSH_CORDIS_CONFIG = cordisConfigPath;
  const nodePath = buildRuntimeNodePath(harnessRoot, env.NODE_PATH ?? process.env.NODE_PATH);
  if (nodePath) env.NODE_PATH = nodePath;

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  if (instructionsFilePath) {
    try {
      env.DSH_SYSTEM_PROMPT = await fs.readFile(instructionsFilePath, "utf8");
    } catch {
      await onLog(
        "stderr",
        `[paperclip] DeepSeek instructions file was missing: ${instructionsFilePath}\n`,
      );
    }
  }

  const runtimeSession = sessionCodec.deserialize(runtime.sessionParams) ?? {};
  const savedSessionId = asString(runtimeSession.sessionId, runtime.sessionId ?? "");
  const savedCwd = asString(runtimeSession.cwd, "");
  const savedSessionRoot = asString(runtimeSession.sessionRoot, "");
  const persist = persistSessionEnabled(config);
  const canResume =
    persist &&
    canResumeDeepseekSession({
      sessionId: savedSessionId || null,
      savedCwd: savedCwd || null,
      savedSessionRoot: savedSessionRoot || null,
      cwd,
      sessionRoot,
    });
  let sessionId = canResume ? savedSessionId : persist ? mintSessionId() : mintSessionId();
  if (savedSessionId && !canResume) {
    await onLog(
      "stdout",
      `[paperclip] DeepSeek session "${savedSessionId}" does not match cwd/sessionRoot and will not be resumed.\n`,
    );
  }

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(canResume && savedSessionId),
  });
  const renderedPrompt =
    (canResume && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, {
          agentId: agent.id,
          companyId: agent.companyId,
          runId,
          company: { id: agent.companyId },
          agent,
          run: { id: runId, source: "on_demand" },
          context,
        });
  const prompt = joinPromptSections([
    wakePrompt,
    asString(context.paperclipSessionHandoffMarkdown, "").trim(),
    renderedPrompt,
  ]);

  const runtimeEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  if (onMeta) {
    await onMeta({
      adapterType: ADAPTER_TYPE,
      command,
      cwd,
      commandNotes: [
        "Drives DeepSeek Harness over JSON-RPC stdio (initialize + session/prompt).",
        `Cordis config: ${cordisConfigPath}`,
        harnessRoot ? `Harness root / NODE_PATH: ${harnessRoot}` : "No harnessRoot set; plugins must resolve from the configuration project.",
        "Do not add a stdout logger to the Cordis composition.",
      ],
      env: buildInvocationEnvForLogs(env, { runtimeEnv }),
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        wakePromptChars: wakePrompt.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context: { sessionId, sessionRoot, model, provider },
    });
  }

  const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 30 * 60 * 1000;
  let timedOut = false;
  let clearSession = false;
  let exitCode: number | null = 0;
  let signal: string | null = null;
  let errorMessage: string | null = null;

  const runtimeHandle = await spawnDeepseekRuntime({
    command,
    args: asStringArray(config.extraArgs),
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
      cwd,
      provider,
      model,
      ...(maxTokens > 0 ? { maxTokens } : {}),
    });

    const runPrompt = async (id: string) =>
      promptAndWait({
        client: runtimeHandle.client,
        sessionId: id,
        prompt,
        timeoutMs,
        onNotification: emitNotification,
      });

    try {
      const turn = await runPrompt(sessionId);
      const parsed = parseTurnNotifications(turn.notifications);
      errorMessage = parsed.errorMessage;
      if (parsed.unknownSession) {
        clearSession = true;
        sessionId = mintSessionId();
        await onLog("stdout", `[paperclip] DeepSeek session was unknown; retrying with a fresh session.\n`);
        const retry = await runPrompt(sessionId);
        const retryParsed = parseTurnNotifications(retry.notifications);
        const closed = await runtimeHandle.close(graceSec * 1000);
        return buildResult({
          sessionId,
          cwd,
          sessionRoot,
          model,
          provider,
          persist,
          parsed: retryParsed,
          exitCode: closed.exitCode ?? (retryParsed.errorMessage ? 1 : 0),
          signal: closed.signal,
          timedOut: false,
          clearSession: true,
        });
      }
      const closed = await runtimeHandle.close(graceSec * 1000);
      exitCode = closed.exitCode ?? (parsed.errorMessage ? 1 : 0);
      signal = closed.signal;
      return buildResult({
        sessionId,
        cwd,
        sessionRoot,
        model,
        provider,
        persist,
        parsed,
        exitCode,
        signal,
        timedOut: false,
        clearSession: false,
      });
    } catch (error) {
      const message = formatRpcError(error);
      if (isUnknownSessionError(message)) {
        clearSession = true;
        sessionId = mintSessionId();
        await onLog("stdout", `[paperclip] DeepSeek session was unknown; retrying with a fresh session.\n`);
        try {
          const retry = await runPrompt(sessionId);
          const retryParsed = parseTurnNotifications(retry.notifications);
          const closed = await runtimeHandle.close(graceSec * 1000);
          return buildResult({
            sessionId,
            cwd,
            sessionRoot,
            model,
            provider,
            persist,
            parsed: retryParsed,
            exitCode: closed.exitCode ?? (retryParsed.errorMessage ? 1 : 0),
            signal: closed.signal,
            timedOut: false,
            clearSession: true,
          });
        } catch (retryError) {
          const retryMessage = formatRpcError(retryError);
          const closed = await runtimeHandle.close(graceSec * 1000);
          return {
            exitCode: closed.exitCode ?? 1,
            signal: closed.signal,
            timedOut: /timed out/i.test(retryMessage),
            errorMessage: retryMessage,
            errorFamily: classifyDeepseekError(retryMessage),
            clearSession: true,
            provider: "deepseek",
            model,
            usageBasis: "per_run",
          };
        }
      }
      timedOut = /timed out/i.test(message);
      errorMessage = message;
      const closed = await runtimeHandle.close(graceSec * 1000);
      exitCode = timedOut ? null : (closed.exitCode ?? 1);
      signal = closed.signal;
      return {
        exitCode,
        signal,
        timedOut,
        errorMessage,
        errorFamily: classifyDeepseekError(message),
        clearSession,
        provider: "deepseek",
        model,
        usageBasis: "per_run",
        ...(persist
          ? {
              sessionId,
              sessionParams: { sessionId, cwd, sessionRoot },
              sessionDisplayId: sessionId,
            }
          : {}),
      };
    }
  } catch (error) {
    errorMessage = formatRpcError(error);
    const closed = await runtimeHandle.close(graceSec * 1000);
    return {
      exitCode: closed.exitCode ?? 1,
      signal: closed.signal,
      timedOut: false,
      errorMessage,
      errorFamily: classifyDeepseekError(errorMessage),
      provider: "deepseek",
      model,
      usageBasis: "per_run",
    };
  }
}

function buildResult(input: {
  sessionId: string;
  cwd: string;
  sessionRoot: string;
  model: string;
  provider: string;
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
