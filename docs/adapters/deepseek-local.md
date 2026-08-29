---
title: DeepSeek Harness
summary: DeepSeek Harness JSON-RPC adapter setup and configuration
---

The `deepseek_local` adapter runs [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as a Paperclip coding agent. Heartbeats talk to `dsh-jsonrpc-agent` over NDJSON JSON-RPC (`initialize`, `session/prompt`, `shutdown`) and resume the same `sessionId`. Compatible with DeepSeek Harness `0.1.1-rc.2`.

This adapter does **not** use `dsh --profile headless` or `dsh-acp`. ACP cannot resume sessions and keeps tools off the wire.

## Prerequisites

A working runtime is three pieces, not `npm i -g @deepseek-ai/dsh-sdk-jsonrpc-demo` alone:

1. `dsh-jsonrpc-agent` on `PATH`, or `adapterConfig.command`
2. A DeepSeek Harness install (`adapterConfig.harnessRoot` or `DSH_HARNESS_ROOT`) so `NODE_PATH=<harnessRoot>/node_modules` can load `@deepseek-ai/dsh-*` plugins
3. Paperclip's shipped `paperclip.cordis.yml` (or `cordisConfigPath`)

Closed alternative: the Python `deepseek-harness-runtime-bin` executable.

Stdout is the protocol. Do not add a stdout logger to the Cordis composition.

## Auth

- `DEEPSEEK_API_KEY` (required)
- `DEEPSEEK_BASE_URL` (optional OpenAI-compatible proxy)

There is no Claude `setup-token` login.

## Configuration fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `deepseek-v4-flash` | JSON-RPC `initialize.model` |
| `provider` | string | `deepseek-official` | JSON-RPC `initialize.provider` |
| `harnessRoot` | string | — | Harness install used for plugin `NODE_PATH` |
| `command` | string | `dsh-jsonrpc-agent` | JSON-RPC stdio binary |
| `cordisConfigPath` | string | shipped composition | Override `DSH_CORDIS_CONFIG` |
| `cwd` | string | workspace cwd | Absolute fallback working directory |
| `persistSession` | boolean | true | Reuse `sessionId` across heartbeats |
| `timeoutSec` | number | 0 | Wall-clock timeout; 0 disables |
| `graceSec` | number | 15 | SIGTERM grace |
| `maxTokens` | number | — | Optional `initialize.maxTokens` |
| `instructionsFilePath` | string | — | Injected as `DSH_SYSTEM_PROMPT` |
| `env` | object | {} | Secret refs allowed |

Cheap model profile: `deepseek-v4-flash`.

## Sessions

Paperclip generates a `sessionId` and sends it on every `session/prompt`. Session files live under `$PAPERCLIP_HOME/adapter-state/<company>/<agent>/deepseek/sessions` (`DSH_SESSION_ROOT`), not `~/.dsh`. A cwd or session-root mismatch starts a fresh session.

## Skills

Desired Paperclip skills are copied into `$PAPERCLIP_HOME/adapter-state/<company>/<agent>/deepseek/skills` and passed as `dsh-skill-filesystem` `customSkillDirs` via `DSH_BUNDLED_SKILL_DIR`. `~/.dsh/skills` and `~/.agents/skills` remain visible as read-only external roots.

## Remote / sandbox

`deepseek_local` is a remote-managed adapter (local, SSH, and sandbox). Execution targets only accept one-shot stdin, so Paperclip uploads a one-shot JSON-RPC bridge plus the shipped Cordis file, skill root, and session root. The bridge owns the duplex `initialize` / `session/prompt` / idle interval on the target and prints `paperclipDeepseek` JSONL plus a final `bridge-result`.

`getRuntimeCommandSpec.installCommand` is `null`. The remote host must already have `dsh-jsonrpc-agent` (or `adapterConfig.command`) and a harness install that can resolve `@deepseek-ai/dsh-*` plugins. Workspace restore runs in `finally` and never `git push`. After each remote turn the bridge writes `.paperclip-session-export.json` so Paperclip can copy session files back onto the host `DSH_SESSION_ROOT`.

Local Linux hosts can also set `filesystemScope=workspace` and/or `networkScope=deny|allowlist` to wrap the JSON-RPC runtime with the same `bwrap` confinement other local adapters use.
