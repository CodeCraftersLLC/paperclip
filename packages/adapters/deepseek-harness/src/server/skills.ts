import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  materializePaperclipSkillCopy,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE } from "../shared/constants.js";
import { resolvePaperclipHome } from "./runtime-config.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveDeepseekSkillsDir(input: { companyId: string; agentId: string }): string {
  return path.join(
    resolvePaperclipHome(),
    "adapter-state",
    input.companyId,
    input.agentId,
    "deepseek",
    "skills",
  );
}

export async function materializeDeepseekSkills(input: {
  config: Record<string, unknown>;
  destDir: string;
}): Promise<number> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(input.config, moduleDir);
  const desired = new Set(resolvePaperclipDesiredSkillNames(input.config, availableEntries));
  await fs.mkdir(input.destDir, { recursive: true });
  const existing = await fs.readdir(input.destDir, { withFileTypes: true });
  await Promise.all(
    existing.map((entry) => fs.rm(path.join(input.destDir, entry.name), { recursive: true, force: true })),
  );
  let count = 0;
  for (const entry of availableEntries) {
    if (!desired.has(entry.key)) continue;
    await materializePaperclipSkillCopy(entry.source, path.join(input.destDir, entry.runtimeName));
    count += 1;
  }
  return count;
}

async function buildSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
  const agentsHome = process.env.DSH_AGENTS_HOME?.trim() || path.join(os.homedir(), ".agents");
  const userDsh = await readInstalledSkillTargets(path.join(dshHome, "skills"));
  const userAgents = await readInstalledSkillTargets(path.join(agentsHome, "skills"));
  const externalInstalled = new Map([...userDsh, ...userAgents]);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: ADAPTER_TYPE,
    availableEntries,
    desiredSkills,
    mode: "ephemeral",
    configuredDetail:
      "Copied into the Paperclip-managed DeepSeek skill root and passed as dsh-skill-filesystem customSkillDirs on the next run.",
    externalInstalled,
    externalLocationLabel: "~/.dsh/skills or ~/.agents/skills",
    externalDetail: "Discovered by DeepSeek Harness as a native/external skill root. Paperclip does not mutate it.",
  });
}

export async function listDeepseekSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config);
}

export async function syncDeepseekSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const destDir = resolveDeepseekSkillsDir({ companyId: ctx.companyId, agentId: ctx.agentId });
  await materializeDeepseekSkills({ config: ctx.config, destDir });
  return buildSnapshot(ctx.config);
}
