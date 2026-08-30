import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
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
import { sessionCodec } from "./session.js";
import {
  persistSessionEnabled,
  resolveCordisConfigPath,
  resolveDeepseekCommand,
  resolveDeepseekModel,
  resolveDeepseekProvider,
  resolveDeepseekSessionRoot,
  resolveGraceSec,
  resolveHarnessRoot,
  resolveTimeoutSec,
  buildRuntimeNodePath,
} from "./runtime-config.js";
import { materializeDeepseekSkills, resolveDeepseekSkillsDir } from "./skills.js";

export interface DeepseekExecuteSetup {
  cwd: string;
  env: Record<string, string>;
  envConfig: Record<string, unknown>;
  command: string;
  extraArgs: string[];
  harnessRoot: string | null;
  cordisConfigPath: string;
  model: string;
  provider: string;
  timeoutSec: number;
  graceSec: number;
  timeoutMs: number;
  maxTokens: number;
  sessionRoot: string;
  skillsDir: string | null;
  persist: boolean;
  savedSessionId: string;
  savedCwd: string;
  savedSessionRoot: string;
  wakePrompt: string;
  renderedPrompt: string;
  prompt: string;
  workspaceCwd: string;
  workspaceSource: string;
  workspaceId: string;
  workspaceRepoUrl: string;
  workspaceRepoRef: string;
  workspaceHints: Array<Record<string, unknown>>;
  agentHome: string;
  sessionId: string;
}

export async function resolveDeepseekExecuteSetup(
  ctx: AdapterExecutionContext,
  input: { sessionId: string; canResume: boolean },
): Promise<DeepseekExecuteSetup> {
  const { runId, agent, runtime, config, context, onLog, authToken } = ctx;
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

  const wakeTaskId = asString(context.taskId, "") || asString(context.issueId, "") || null;
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
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf8");
      const instructionsFileDir = path.dirname(path.resolve(instructionsFilePath));
      env.DSH_SYSTEM_PROMPT =
        `${instructionsContent}\nThe above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.`;
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

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: input.canResume,
  });
  const renderedPrompt =
    (input.canResume && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
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

  const contextRecord = context as Record<string, unknown>;
  const paperclipWorkspaces = Array.isArray(contextRecord.paperclipWorkspaces)
    ? contextRecord.paperclipWorkspaces.filter((value): value is Record<string, unknown> => (
      typeof value === "object" && value !== null && !Array.isArray(value)
    ))
    : [];

  return {
    cwd,
    env,
    envConfig,
    command,
    extraArgs: [],
    harnessRoot,
    cordisConfigPath,
    model,
    provider,
    timeoutSec,
    graceSec,
    timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : 30 * 60 * 1000,
    maxTokens,
    sessionRoot,
    skillsDir: stagedSkills > 0 ? skillsDir : null,
    persist,
    savedSessionId,
    savedCwd,
    savedSessionRoot,
    wakePrompt,
    renderedPrompt,
    prompt,
    workspaceCwd,
    workspaceSource,
    workspaceId: asString(workspaceContext.workspaceId, asString(workspaceContext.id, "")),
    workspaceRepoUrl: asString(workspaceContext.repoUrl, ""),
    workspaceRepoRef: asString(workspaceContext.repoRef, ""),
    workspaceHints: paperclipWorkspaces,
    agentHome: asString(workspaceContext.agentHome, ""),
    sessionId: input.sessionId,
  };
}
