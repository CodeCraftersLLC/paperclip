import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  readAdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { asNumber, asString, ensureAbsoluteDirectory, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE, DEFAULT_HELLO_PROBE_TIMEOUT_SEC } from "../shared/constants.js";
import {
  resolveCordisConfigPath,
  resolveDeepseekCommand,
  resolveDeepseekModel,
  resolveDeepseekProvider,
  resolveHarnessRoot,
} from "./runtime-config.js";
import {
  formatRpcError,
  initializeRuntime,
  mintSessionId,
  promptAndWait,
  spawnDeepseekRuntime,
} from "./jsonrpc-runtime.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) env[key] = value;
  }
  return env;
}

function hasApiKey(env: Record<string, string>): boolean {
  return Boolean((env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "").trim());
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const env = normalizeEnv(config.env);
  const command = resolveDeepseekCommand(config, env);
  const harnessRoot = resolveHarnessRoot(config, env);
  const cordisConfigPath = resolveCordisConfigPath(config, env);
  const model = resolveDeepseekModel(config, env);
  const provider = resolveDeepseekProvider(config);
  const cwd = asString(config.cwd, process.cwd());
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: null,
  });
  const targetIsRemote = target?.kind === "remote";
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : "local host";

  checks.push({
    code: "target",
    level: "info",
    message: `Probing ${targetLabel}`,
  });

  if (targetIsRemote) {
    checks.push({
      code: "remote_not_implemented",
      level: "warn",
      message: "deepseek_local remote environment probes land in Phase 3. Local JSON-RPC checks ran on the Paperclip host.",
    });
  }

  try {
    if (!path.isAbsolute(cwd)) {
      throw new Error(`Working directory must be absolute: ${cwd}`);
    }
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "cwd",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (error) {
    checks.push({
      code: "cwd",
      level: "error",
      message: error instanceof Error ? error.message : "Invalid working directory",
      detail: cwd,
    });
  }

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, null, cwd, {
      ...process.env,
      ...env,
    });
    checks.push({
      code: "cli_detected",
      level: "info",
      message: `JSON-RPC runtime is executable: ${command}`,
    });
  } catch (error) {
    checks.push({
      code: "cli_detected",
      level: "error",
      message: error instanceof Error ? error.message : "dsh-jsonrpc-agent was not found",
      detail: command,
      hint: "Install DeepSeek Harness (source checkout, @deepseek-ai/dsh, or the Python closed runtime). npm i -g @deepseek-ai/dsh-sdk-jsonrpc-demo alone does not ship plugins. Set harnessRoot so NODE_PATH can resolve @deepseek-ai/dsh-* from that install.",
    });
  }

  if (!hasApiKey(env)) {
    const looksLikeSecretRef = Object.values(parseObject(config.env)).some(
      (value) => typeof value === "object" && value !== null,
    );
    checks.push({
      code: looksLikeSecretRef ? "environment_env_binding_missing" : "api_key",
      level: "error",
      message: "DEEPSEEK_API_KEY is required",
      hint: "Set it on the agent env, selected environment secret refs, or the Paperclip process environment. Optional DEEPSEEK_BASE_URL selects an OpenAI-compatible proxy.",
    });
  } else {
    checks.push({
      code: "api_key",
      level: "info",
      message: "DEEPSEEK_API_KEY is present",
    });
  }

  checks.push({
    code: "model",
    level: "info",
    message: `Model ${model} via ${provider}`,
  });

  if (!harnessRoot) {
    checks.push({
      code: "harness_root",
      level: "warn",
      message: "harnessRoot is unset. Bare Cordis plugins resolve from the configuration project, not from Paperclip node_modules.",
      hint: "Set adapterConfig.harnessRoot or DSH_HARNESS_ROOT to a DeepSeek Harness install.",
    });
  } else {
    checks.push({
      code: "harness_root",
      level: "info",
      message: `Harness root: ${harnessRoot}`,
    });
  }

  try {
    await fs.access(cordisConfigPath);
    checks.push({
      code: "cordis_config",
      level: "info",
      message: `Cordis config: ${cordisConfigPath}`,
    });
  } catch {
    checks.push({
      code: "cordis_config",
      level: "error",
      message: `Cordis config is missing: ${cordisConfigPath}`,
    });
  }

  const canProbe =
    checks.every((check) => check.level !== "error") &&
    command.length > 0 &&
    hasApiKey(env);

  if (canProbe) {
    const probeCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dsh-probe-"));
    const timeoutSec = Math.max(5, asNumber(config.helloProbeTimeoutSec, DEFAULT_HELLO_PROBE_TIMEOUT_SEC));
    try {
      const runtime = await spawnDeepseekRuntime({
        command,
        cwd: probeCwd,
        env: {
          ...process.env,
          ...env,
          DSH_CWD: probeCwd,
          DSH_CORDIS_CONFIG: cordisConfigPath,
          DSH_SESSION_ROOT: path.join(probeCwd, "sessions"),
          DSH_MODEL: model,
          ...(harnessRoot
            ? { NODE_PATH: `${path.join(harnessRoot, "node_modules")}${path.delimiter}${process.env.NODE_PATH ?? ""}` }
            : {}),
        },
      });
      try {
        await initializeRuntime(runtime.client, { cwd: probeCwd, provider, model });
        await promptAndWait({
          client: runtime.client,
          sessionId: mintSessionId(),
          prompt: "Respond with hello.",
          timeoutMs: timeoutSec * 1000,
        });
        checks.push({
          code: "hello_probe",
          level: "info",
          message: "JSON-RPC initialize + session/prompt succeeded",
        });
      } finally {
        await runtime.close(5_000);
      }
    } catch (error) {
      checks.push({
        code: "hello_probe",
        level: "error",
        message: formatRpcError(error),
        hint: "Confirm DEEPSEEK_API_KEY, DSH_CORDIS_CONFIG, and that harness plugins resolve from harnessRoot/node_modules.",
      });
    } finally {
      await fs.rm(probeCwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    adapterType: ADAPTER_TYPE,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
