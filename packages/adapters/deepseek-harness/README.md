# @paperclipai/adapter-deepseek-harness

Paperclip adapter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`deepseek_local`).

Heartbeat execute talks to `dsh-jsonrpc-agent` over NDJSON JSON-RPC (`initialize`, `session/prompt`, `shutdown`). Compatible with DeepSeek Harness `0.1.1-rc.2`.

## This is not `npm i -g @deepseek-ai/dsh-sdk-jsonrpc-demo`

That package only ships the JSON-RPC bin. The bin boots `$DSH_CORDIS_CONFIG` (required) and resolves bare `@deepseek-ai/dsh-*` plugins from the **configuration project** / `NODE_PATH`. A working runtime is:

1. `dsh-jsonrpc-agent` on `PATH`, or `adapterConfig.command`
2. A DeepSeek Harness install (`adapterConfig.harnessRoot` or `DSH_HARNESS_ROOT`) so `NODE_PATH=<harnessRoot>/node_modules` can load plugins
3. Paperclip's shipped `paperclip.cordis.yml` (or `adapterConfig.cordisConfigPath`)

Closed alternative: the Python `deepseek-harness-runtime-bin` executable.

Do not add a stdout logger to the Cordis composition. Stdout is the protocol.

## Auth

- `DEEPSEEK_API_KEY` (required)
- `DEEPSEEK_BASE_URL` (optional)

There is no Claude `setup-token` login. ACP is not advertised: dsh ACP is fresh-session-only and keeps tools off the wire.

## Sessions

Paperclip generates a `sessionId` and reuses it on `session/prompt`. Session files live under `$PAPERCLIP_HOME/adapter-state/<company>/<agent>/deepseek/sessions` (`DSH_SESSION_ROOT`), not `~/.dsh`.
