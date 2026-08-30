import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../shared/constants.js";

export const CURATED_DEEPSEEK_MODELS = [
  { id: DEFAULT_MODEL, label: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

export async function listDeepseekModels(): Promise<Array<{ id: string; label: string }>> {
  return CURATED_DEEPSEEK_MODELS;
}

export async function refreshDeepseekModels(): Promise<Array<{ id: string; label: string }>> {
  return listDeepseekModels();
}

export async function detectModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null> {
  const envModel = process.env.DSH_MODEL?.trim();
  if (envModel) {
    return {
      model: envModel,
      provider: process.env.DSH_PROVIDER?.trim() || DEFAULT_PROVIDER,
      source: "DSH_MODEL",
      candidates: CURATED_DEEPSEEK_MODELS.map((model) => model.id),
    };
  }

  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  try {
    const content = await readFile(join(dshHome, "config.yaml"), "utf8");
    const modelMatch = content.match(/^\s*model:\s*["']?([^\s"']+)/m);
    const providerMatch = content.match(/^\s*provider:\s*["']?([^\s"']+)/m);
    if (modelMatch?.[1]) {
      return {
        model: modelMatch[1],
        provider: providerMatch?.[1] || DEFAULT_PROVIDER,
        source: `${dshHome}/config.yaml`,
        candidates: CURATED_DEEPSEEK_MODELS.map((model) => model.id),
      };
    }
  } catch {
    // no local dsh config
  }

  return {
    model: DEFAULT_MODEL,
    provider: DEFAULT_PROVIDER,
    source: "adapter_default",
    candidates: CURATED_DEEPSEEK_MODELS.map((model) => model.id),
  };
}
