import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_SEC,
} from "../shared/constants.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "text",
        default: DEFAULT_MODEL,
        hint: "DeepSeek model id. Default is deepseek-v4-flash.",
      },
      {
        key: "provider",
        label: "Provider",
        type: "text",
        default: DEFAULT_PROVIDER,
        hint: "JSON-RPC initialize.provider. Default is deepseek-official.",
      },
      {
        key: "harnessRoot",
        label: "Harness install root",
        type: "text",
        hint: "Path to a DeepSeek Harness checkout or install. Used to resolve plugins via NODE_PATH=<harnessRoot>/node_modules.",
      },
      {
        key: "command",
        label: "JSON-RPC command",
        type: "text",
        hint: "Defaults to dsh-jsonrpc-agent. The bin does not ship the plugin tree; pair it with harnessRoot or a closed runtime.",
      },
      {
        key: "cordisConfigPath",
        label: "Cordis config path",
        type: "text",
        hint: "Override DSH_CORDIS_CONFIG. Defaults to the shipped Paperclip composition.",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute fallback cwd when the heartbeat workspace is unset.",
      },
      {
        key: "persistSession",
        label: "Persist session",
        type: "toggle",
        default: true,
        hint: "Reuse the same DeepSeek sessionId across heartbeats.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
        hint: "0 means no Paperclip wall-clock timeout.",
      },
      {
        key: "graceSec",
        label: "Grace seconds",
        type: "number",
        default: DEFAULT_GRACE_SEC,
        hint: "Seconds to wait after SIGTERM before SIGKILL.",
      },
      {
        key: "maxTokens",
        label: "Max tokens",
        type: "number",
        hint: "Optional initialize.maxTokens output cap.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Optional custom prompt template with {{variable}} placeholders.",
      },
      {
        key: "filesystemScope",
        label: "Filesystem scope",
        type: "text",
        hint: "Set to workspace to confine the local JSON-RPC runtime with bwrap (Linux only).",
      },
      {
        key: "networkScope",
        label: "Network scope",
        type: "text",
        hint: "deny or allowlist. Linux-only local confinement around the JSON-RPC runtime.",
      },
    ],
  };
}
