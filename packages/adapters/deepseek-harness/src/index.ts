import type {
  AdapterModelProfileDefinition,
  AdapterRuntimeCommandSpec,
  AdapterSessionManagement,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { ADAPTER_LABEL, ADAPTER_TYPE, DEFAULT_MODEL, DSH_COMPAT_VERSION } from "./shared/constants.js";
import {
  detectModel,
  execute,
  getConfigSchema,
  listDeepseekModels,
  listDeepseekSkills,
  refreshDeepseekModels,
  sessionCodec,
  syncDeepseekSkills,
  testEnvironment,
} from "./server/index.js";
import { resolveDeepseekCommand } from "./server/runtime-config.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_MODEL, label: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Flash model for low-cost heartbeats",
    adapterConfig: { model: DEFAULT_MODEL },
    source: "adapter_default",
  },
];

const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0,
  },
};

function getRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = resolveDeepseekCommand(config);
  return {
    command,
    detectCommand: command,
    installCommand: null,
  };
}

export const agentConfigurationDoc = `# DeepSeek Harness agent configuration

Adapter: deepseek_local

Use when:
- You want Paperclip to run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as a local coding agent
- You need session resume across heartbeats over the JSON-RPC stdio SDK
- You have a DeepSeek API key (\`DEEPSEEK_API_KEY\`)

Don't use when:
- You only need a raw DeepSeek chat-completions wrapper
- You expected Claude setup-token OAuth or ACP (this adapter does not advertise ACP)
- The host only has \`npm i -g @deepseek-ai/dsh-sdk-jsonrpc-demo\` — that bin does not ship the plugin tree

## Runtime

Paperclip talks to \`dsh-jsonrpc-agent\` over NDJSON JSON-RPC (\`initialize\`, \`session/prompt\`, \`shutdown\`).
Compatible with DeepSeek Harness \`${DSH_COMPAT_VERSION}\`.

The JSON-RPC bin boots \`$DSH_CORDIS_CONFIG\` and resolves bare \`@deepseek-ai/dsh-*\` plugins from the **configuration project** / \`NODE_PATH\`. A working runtime is:

1. \`dsh-jsonrpc-agent\` on PATH (or \`adapterConfig.command\`)
2. A DeepSeek Harness install (\`adapterConfig.harnessRoot\` or \`DSH_HARNESS_ROOT\`)
3. Paperclip's shipped \`paperclip.cordis.yml\` (or \`cordisConfigPath\`)

Do not add a stdout logger to the Cordis composition. Stdout is the protocol.

## Auth

- \`DEEPSEEK_API_KEY\` (required)
- \`DEEPSEEK_BASE_URL\` (optional OpenAI-compatible proxy)

There is no \`claude setup-token\` login flow.

## Core fields

| Field | Default | Notes |
|-------|---------|-------|
| model | deepseek-v4-flash | JSON-RPC \`initialize.model\` |
| provider | deepseek-official | JSON-RPC \`initialize.provider\` |
| harnessRoot | — | Install root used for \`NODE_PATH=<root>/node_modules\` |
| command | dsh-jsonrpc-agent | JSON-RPC stdio bin |
| persistSession | true | Reuse \`sessionId\` across heartbeats |
| cwd | workspace cwd | Absolute fallback |
| timeoutSec | 0 | Wall-clock kill; 0 disables |
| graceSec | 15 | SIGTERM grace |
| env | {} | Secret refs allowed |

Sessions are stored under \`$PAPERCLIP_HOME/adapter-state/<company>/<agent>/deepseek/sessions\` (\`DSH_SESSION_ROOT\`), not \`~/.dsh\`.
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    models,
    modelProfiles,
    listModels: listDeepseekModels,
    refreshModels: refreshDeepseekModels,
    listSkills: listDeepseekSkills,
    syncSkills: syncDeepseekSkills,
    detectModel,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    getRuntimeCommandSpec,
    agentConfigurationDoc,
    getConfigSchema,
  };
}
