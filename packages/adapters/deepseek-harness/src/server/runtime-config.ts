import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_COMMAND,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_SEC,
} from "../shared/constants.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function shippedCordisConfigPath(): string {
  return path.resolve(moduleDir, "paperclip.cordis.yml");
}

export function resolvePaperclipHome(): string {
  const raw = process.env.PAPERCLIP_HOME?.trim();
  if (raw) return path.resolve(raw);
  return path.resolve(os.homedir(), ".paperclip");
}

export function resolveDeepseekSessionRoot(input: {
  companyId: string;
  agentId: string;
  sessionRoot?: string;
}): string {
  if (input.sessionRoot?.trim()) return path.resolve(input.sessionRoot.trim());
  return path.join(
    resolvePaperclipHome(),
    "adapter-state",
    input.companyId,
    input.agentId,
    "deepseek",
    "sessions",
  );
}

export function resolveHarnessRoot(config: Record<string, unknown>, env: Record<string, string>): string | null {
  const fromConfig = asString(config.harnessRoot, "").trim();
  if (fromConfig) return path.resolve(fromConfig);
  const fromEnv = (env.DSH_HARNESS_ROOT ?? process.env.DSH_HARNESS_ROOT ?? "").trim();
  return fromEnv ? path.resolve(fromEnv) : null;
}

export function resolveDeepseekCommand(config: Record<string, unknown>, env: Record<string, string> = {}): string {
  const explicit = asString(config.command, "").trim();
  if (explicit) return explicit;
  const fromEnv = (env.DSH_JSONRPC_COMMAND ?? process.env.DSH_JSONRPC_COMMAND ?? "").trim();
  if (fromEnv) return fromEnv;
  const harnessRoot = resolveHarnessRoot(config, env);
  if (harnessRoot) {
    const bin = path.join(harnessRoot, "node_modules", ".bin", DEFAULT_COMMAND);
    if (fs.existsSync(bin)) return bin;
  }
  return DEFAULT_COMMAND;
}

export function resolveCordisConfigPath(config: Record<string, unknown>, env: Record<string, string> = {}): string {
  const explicit = asString(config.cordisConfigPath, "").trim();
  if (explicit) return path.resolve(explicit);
  const fromEnv = (env.DSH_CORDIS_CONFIG ?? process.env.DSH_CORDIS_CONFIG ?? "").trim();
  if (fromEnv) return path.resolve(fromEnv);
  return shippedCordisConfigPath();
}

export function resolveDeepseekModel(config: Record<string, unknown>, env: Record<string, string> = {}): string {
  return asString(config.model, "").trim() || env.DSH_MODEL?.trim() || DEFAULT_MODEL;
}

export function resolveDeepseekProvider(config: Record<string, unknown>): string {
  return asString(config.provider, "").trim() || DEFAULT_PROVIDER;
}

export function resolveTimeoutSec(config: Record<string, unknown>): number {
  const value = config.timeoutSec;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : DEFAULT_TIMEOUT_SEC;
}

export function resolveGraceSec(config: Record<string, unknown>): number {
  const value = config.graceSec;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, value) : DEFAULT_GRACE_SEC;
}

export function persistSessionEnabled(config: Record<string, unknown>): boolean {
  return config.persistSession !== false;
}

export function buildRuntimeNodePath(harnessRoot: string | null, existing?: string): string | undefined {
  if (!harnessRoot) return existing;
  const modules = path.join(harnessRoot, "node_modules");
  if (!existing) return modules;
  return `${modules}${path.delimiter}${existing}`;
}

export function adapterStateLabel(): string {
  return ADAPTER_TYPE;
}
