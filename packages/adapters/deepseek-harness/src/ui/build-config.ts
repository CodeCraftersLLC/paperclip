import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_GRACE_SEC, DEFAULT_MODEL, DEFAULT_TIMEOUT_SEC } from "../shared/constants.js";

export function buildDeepseekConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {
    model: v.model.trim() || DEFAULT_MODEL,
    persistSession: true,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    graceSec: DEFAULT_GRACE_SEC,
  };
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.command) ac.command = v.command;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.extraArgs) ac.extraArgs = v.extraArgs;
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  return ac;
}
