# DeepSeek Harness Adapter — Full Paperclip-Feature Parity Plan

Status: Complete (`feat/deepseek-harness-support`)
Date: 2026-08-29
Audience: Engineering
Scope: Add a Paperclip agent adapter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) that matches `claude_local` on Paperclip control-plane features (heartbeat execute, sessions, skills, instructions, usage, transcripts, env test, remote/sandbox, JWT, config schema). Not a goal: make `dsh` behave like Claude Code.

Primary references (local checkouts):

- Paperclip Claude adapter: `packages/adapters/claude-local/`
- Paperclip adapter contract: `packages/adapter-utils/src/types.ts` (`ServerAdapterModule`)
- Paperclip plugin loader: `server/src/adapters/plugin-loader.ts`
- Paperclip adapter docs: `docs/adapters/creating-an-adapter.md`, `docs/adapters/external-adapters.md`
- DeepSeek Harness: `/Users/mikestaub/code/codecrafters/ai-coding-tools/deepseek-harness`
  - CLI: `apps/cli/README.md`
  - Headless: `packages/bundle/headless/README.md`
  - JSON-RPC protocol: `packages/sdk/protocol/src/types.ts`
  - TS SDK client: `packages/sdk/client/src/api.ts`
  - JSON-RPC server: `packages/sdk/server/README.md`
  - ACP (do not use as primary): `packages/acp/acp/README.md`
  - Skills: `packages/skill/skill-filesystem/README.md`
  - Session events: `packages/core/session/src/types.ts`

---

## 1. Goal

Ship `@paperclipai/adapter-deepseek-harness` as a first-class Paperclip adapter package that:

1. Can be loaded as an **external plugin** (`createServerAdapter()` + `./ui-parser`) without forking Paperclip.
2. Is also **registered as a built-in** (Hermes pattern) so hire/onboarding/remote-env/session lists treat it like `claude_local`.
3. On each heartbeat, drives DeepSeek Harness through its **JSON-RPC stdio SDK**, resumes the same session, streams structured events into the run log, and returns usage + session state.

Type key: `deepseek_local`.
Label: `DeepSeek Harness`.

`deepseek_local` matches the existing `*_local` coding-adapter family (`claude_local`, `hermes_local`, `opencode_local`). The package name keeps `harness` so it is not confused with a raw DeepSeek chat-completions wrapper.

---

## 2. Non-goals

- Do not wrap `dsh web` or start the DeepSeek Web UI per heartbeat.
- Do not use `dsh --profile headless` as the production execute path (fresh session, last-assistant-text only, no tool stream).
- Do not use `dsh-acp` as the production execute path. ACP is automation-only, **fresh sessions only**, and keeps reasoning/tool activity off the wire (`packages/acp/acp/README.md`).
- Do not require Python. The Python SDK (`deepseek-harness-sdk`) is the same JSON-RPC protocol with an extra runtime. Paperclip is Node.
- Do not implement Claude-specific product features (Chrome flag, `claude setup-token` OAuth, Bedrock/Vertex, `--dangerously-skip-permissions` as a Claude CLI flag).
- Do not vendor the DeepSeek Harness monorepo into Paperclip.
- Do not treat `doc/SPEC.md` as in-scope product rewrite.

---

## 3. Why JSON-RPC (not headless, not ACP)

DeepSeek Harness exposes three automation surfaces. Only one can meet Claude-level Paperclip features.

| Surface | Invoke | Session resume | Live tools / thinking | Usage | Verdict |
|---|---|---|---|---|---|
| `dsh --profile headless "task"` | one-shot CLI | **No** — “creates one fresh persisted session” | No structured stream; last assistant text on stdout | No | Smoke test only |
| `@deepseek-ai/dsh-acp` | ACP JSON-RPC stdio | **No** — “Fresh sessions only” | Committed assistant text only; tools/reasoning off wire | Off wire | Wrong for Paperclip transcripts |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` + TS/Python client | `initialize` + `session/prompt` | **Yes** — unknown `sessionId` creates; reuse continues | `session.event` includes `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result` | `assistant/message.usage` | **Primary path** |

JSON-RPC wire (`packages/sdk/protocol/src/types.ts`):

- Client → server: `initialize`, `session/prompt`, `shutdown`
- Server → client: `session.event`, `session.status`, `subagent.started`, `subagent.finished`
- `session/prompt({ sessionId, contentBlocks })` queues one user message and returns `{ messageId }` immediately
- Client owns the activity interval: wait until `session.status === "idle"` after the inbox receipt
- `DeepSeekHarness.run(input, { sessionId })` in `packages/sdk/client/src/api.ts` already implements that interval

Stdout is the protocol. Diagnostics must stay on stderr. The Paperclip-owned Cordis composition must not mount a stdout logger.

---

## 4. Parity definition

“Full parity with Claude Code **in terms of Paperclip features**” means the `deepseek_local` `ServerAdapterModule` implements the same host-visible capabilities as `claude_local` in `server/src/adapters/registry.ts`, plus the same host-list membership so environments, heartbeats, and the hire UI treat it as a first-class local coding adapter.

Claude-only product mechanics that have no `dsh` equivalent are marked **N/A (equivalent)**: implement the Paperclip outcome through the DeepSeek-native seam.

### 4.1 ServerAdapterModule checklist

| Paperclip feature | `claude_local` | `deepseek_local` plan |
|---|---|---|
| `type` + `execute` + `testEnvironment` | required | required |
| Session resume (`sessionCodec` + `sessionParams`) | cwd-aware `--resume`; poisoned-session rotate | Persist `{ sessionId, cwd, sessionRoot }`; reuse `sessionId` on JSON-RPC; rotate if cwd/session-root mismatch or runtime rejects the id |
| `sessionManagement` | native context management confirmed; Paperclip compaction thresholds off | Same: `dsh` ships compaction in the coding composition. Register `nativeContextManagement: "confirmed"` |
| `supportsLocalAgentJwt` | true | true — inject `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` / `PAPERCLIP_RUN_ID` |
| `supportsInstructionsBundle` + `instructionsPathKey` | `instructionsFilePath` → prompt bundle / `--append-system-prompt-file` | Read file; pass as `DSH_SYSTEM_PROMPT` and/or a Paperclip-owned persona section in the shipped `cordis.yml` |
| Skills `listSkills` / `syncSkills` | ephemeral prompt-bundle `--add-dir`; also scans `~/.claude/skills` | Materialize desired Paperclip skills into a tmp/custom root; pass via `customSkillDirs` / `DSH_BUNDLED_SKILL_DIR`. Scan `~/.dsh/skills` and `~/.agents/skills` as external |
| `requiresMaterializedRuntimeSkills` | false (ephemeral bundle) | **true** — `dsh-skill-filesystem` discovers on-disk roots, it does not take Claude-style `--add-dir` |
| Models `models` / `listModels` / `refreshModels` | curated + discovered | Curated DeepSeek ids + optional discovery from `dsh` model settings / `DSH_MODEL` |
| `modelProfiles.cheap` | Sonnet + low effort | `deepseek-v4-flash` (or current cheap catalog id) |
| `getConfigSchema` | engine/ACP fields | Model, provider, cwd, timeout, extra env, session persist, effort/max tokens — no ACP engine picker |
| `getRuntimeCommandSpec` | `claude` + npm install | Detect `dsh` / bundled `dsh-jsonrpc-agent`; sandbox install command for `@deepseek-ai/dsh` |
| `getQuotaWindows` | Anthropic OAuth + `claude` usage | Phase 2. Extract per-run `TokenUsage` in V1. Add provider quota only if a stable DeepSeek usage API is confirmed |
| `loginCapability` | PTY `claude setup-token` | **Omit.** Auth is `DEEPSEEK_API_KEY` (+ optional `DEEPSEEK_BASE_URL`). Env-test must fail closed when the key is missing |
| `detectModel` | local Claude config | Read `$DSH_HOME` / profile model + `DSH_MODEL` |
| `agentConfigurationDoc` | yes | yes |
| ACP `acp` descriptor + engine auto/cli/acp | yes | **Do not advertise ACP.** dsh ACP cannot resume or stream tools. JSON-RPC is the richer Paperclip lane |
| Live transcript | Claude stream-json / ACPX events | Mirror `session.event` onto stdout as JSONL; UI parser maps to `TranscriptEntry` |
| CLI `format-event` | yes | yes |
| Error families | quota, refusal, transient, poisoned session | Map `turn/end` `error` / `max-tokens` / auth failures to `AdapterExecutionErrorFamily` |
| `clearSession` | unknown/poisoned session | Unknown session or persistence miss → retry once fresh + `clearSession: true` |
| Workspace restore (no-remote-git) | `prepareAdapterExecutionTargetRuntime` + restore in `finally` | Same helpers; asset keys: skills dir, session root, cordis config, `DSH_HOME` subset |
| SSH / sandbox execution targets | yes | yes, after host list updates (section 7) |
| `filesystemScope` / `networkScope` (bwrap) | yes | Wrap the JSON-RPC runtime process with the same `LocalProcessSandboxOptions` |
| Runtime MCP servers | write Claude MCP config | Phase 2. dsh ACP rejects MCP; JSON-RPC MCP depends on composing an MCP plugin. Do not block V1 |
| `workspaceStrategy` git worktree | consumed from heartbeat workspace context | Honor `context.paperclipWorkspace.cwd` the same way Claude does; do not reimplement worktrees |

### 4.2 Host-list membership (required for real parity)

These are still hardcoded type sets. A plugin that only exports `createServerAdapter()` will **not** get Claude-level environments, git checks, or sessioned-heartbeat behavior until the type is added (or the lists become capability-driven).

| Host list | File | Action |
|---|---|---|
| `AGENT_ADAPTER_TYPES` | `packages/shared/src/constants.ts` | Add `deepseek_local` |
| `BUILTIN_ADAPTER_TYPES` | `server/src/adapters/builtin-adapter-types.ts` | Add `deepseek_local` |
| `REMOTE_MANAGED_ADAPTERS` | `packages/shared/src/environment-support.ts` | Add so SSH/sandbox drivers are offered |
| `ADAPTER_SESSION_MANAGEMENT` | `packages/adapter-utils/src/session-compaction.ts` | `supportsSessionResume: true`, `nativeContextManagement: "confirmed"`, managed compaction policy |
| `LEGACY_SESSIONED_ADAPTER_TYPES` | same file | Add if any fallback still uses it |
| `GIT_SENSITIVE_LOCAL_ADAPTER_TYPES` | `server/src/services/heartbeat.ts` | Add |
| `SESSIONED_LOCAL_ADAPTERS` | `server/src/services/heartbeat.ts` | Add |
| Recovery adapter allowlist | `server/src/services/recovery/service.ts` | Add if that list gates local coding adapters |
| UI display map | `ui/src/adapters/adapter-display-registry.ts` | Label / description / icon |
| UI capability cold defaults | `ui/src/adapters/use-adapter-capabilities.ts` | Match server flags for first render |
| Server registry | `server/src/adapters/registry.ts` | Import and register |
| UI registry | `ui/src/adapters/registry.ts` | Static UI module (built-in path) |
| CLI registry | `cli/src/adapters/registry.ts` | `formatStdoutEvent` |

Prefer a follow-up (not blocking V1) that replaces these lists with `ServerAdapterModule` capability flags (`supportsRemoteManagedEnvironments`, `supportsSessionResume`, `gitSensitive`). V1 should still add the type to the existing lists so parity is not theoretical.

---

## 5. Locked decisions

1. **Primary execute path** is a Paperclip-owned NDJSON JSON-RPC client talking to a `dsh-jsonrpc-agent` subprocess. Published `@deepseek-ai/dsh-sdk-client` / `@deepseek-ai/dsh-sdk-protocol` (`0.1.1-rc.2`) are independently installable on npm (peers rewritten off `workspace:^`), but they pull `dsh-llm` / `dsh-session` / `dsh-subagent` / `cordis` types into Paperclip. Own the wire client for isolation. Match `HarnessSession.run`: subscribe → `session/prompt` → wait for `agent/inbox/spliced` with `inserted[].id === messageId` → collect until `session.status === idle`. Do not copy the Phase 0 spike’s `waitForIdle`.
2. **Paperclip-owned Cordis composition** ships inside the adapter (`src/server/paperclip.cordis.yml`). It must include: JSON-RPC server, DeepSeek official provider, coding tools (bash + filesystem edit, not the `minimal` two-tool preset), skill registry + filesystem provider, unattended approval policy, JSONL persistence, compaction. It must not include web/TUI/stdout logger.
3. **Session identity** is a Paperclip-generated id stored in `agentTaskSessions.session_params_json`. The adapter always sends that id on `session/prompt`. `dsh` lazily creates the agent+session pair.
4. **Session root** is Paperclip-managed (`$PAPERCLIP_HOME/adapter-state/<company>/<agent>/deepseek/sessions` or the execution-target equivalent), passed as `DSH_SESSION_ROOT`. Do not write into the operator’s interactive `~/.dsh` session store by default.
5. **Auth** is env-only: `DEEPSEEK_API_KEY` required; `DEEPSEEK_BASE_URL` optional for OpenAI-compatible proxies. Support adapter `env` + company environment secret refs the same way other local adapters do.
6. **Unattended permissions**: the shipped composition uses a non-interactive allow policy (DeepSeek’s danger-full-access / one-shot auto-allow equivalent). Document this as the DeepSeek analog of Claude’s `dangerouslySkipPermissions: true`. Remote targets still get Paperclip `filesystemScope` / `networkScope` when configured.
7. **Skills injection** uses `dsh-skill-filesystem` `customSkillDirs` (rank 300) pointing at a Paperclip-materialized directory of `SKILL.md` bundles. Project `.dsh/skills` / `.agents/skills` remain visible as native/external.
8. **Distribution** follows Hermes: in-repo package that exports `createServerAdapter()`, registered as built-in, installable as an external override via `~/.paperclip/adapter-plugins.json`.
9. **dsh is developer preview.** Pin a minimum `@deepseek-ai/dsh*` version in the adapter README. Treat protocol drift as expected; isolate wire types behind `src/server/protocol.ts` and fixture-test them.

---

## 6. Package shape

```
packages/adapters/deepseek-harness/
  package.json                          # @paperclipai/adapter-deepseek-harness
  tsconfig.json
  README.md
  src/
    index.ts                            # type, label, models, modelProfiles, agentConfigurationDoc, createServerAdapter
    server/
      index.ts                          # factory
      execute.ts                        # heartbeat execute
      jsonrpc-runtime.ts                # spawn + initialize + prompt + wait idle
      parse.ts                          # session.event → usage / errors / summary
      transcript-jsonl.ts               # emit UI-parser-friendly JSONL on onLog
      session.ts                        # sessionCodec
      skills.ts                         # list/sync + materialize customSkillDirs
      test.ts                           # env diagnostics + hello probe
      models.ts
      config-schema.ts
      runtime-config.ts                 # cwd, env, DSH_* , command detect
      paperclip.cordis.yml              # unattended coding composition
    ui/
      index.ts
      parse-stdout.ts
      build-config.ts
    ui-parser.ts                        # zero-import browser parser
    cli/
      index.ts
      format-event.ts
  skills/                               # optional Paperclip-bundled helper skills
```

`package.json` exports: `.`, `./server`, `./ui`, `./cli`, `./ui-parser`. Set `paperclip.adapterUiParser: "1.0.0"`.

Workspace: add the package to the pnpm workspace the same way `packages/adapters/claude-local` is included. Depend on `@paperclipai/adapter-utils` and `@paperclipai/shared` via `workspace:*`.

---

## 7. Execute design

`execute(ctx)` outline (mirror `claude-local` / `grok-local` structure, swap the child protocol):

1. Resolve execution target (`readAdapterExecutionTarget`). Honor `context.paperclipWorkspace.cwd` over `adapterConfig.cwd` unless the Claude-equivalent agent-home override applies.
2. Build env: `buildPaperclipEnv(agent)` + `PAPERCLIP_RUN_ID` + `PAPERCLIP_API_KEY` from `authToken` + `DEEPSEEK_*` from config/environment + `DSH_CWD`, `DSH_SESSION_ROOT`, `DSH_MODEL`, `DSH_CORDIS_CONFIG` (path to shipped `paperclip.cordis.yml`, copied onto remote targets).
3. Materialize skills into a run-scoped directory; set `customSkillDirs` / env so the filesystem provider sees them.
4. Load instructions from `instructionsFilePath`; fail warn (not hard-fail) if missing, same as Claude.
5. Deserialize `runtime.sessionParams`. If `cwd` or `sessionRoot` changed, drop the session id.
6. `onMeta` with adapter type, runtime command, cwd, redacted env.
7. Spawn JSON-RPC runtime (`runAdapterExecutionTargetProcess` / `runChildProcess`). Do **not** treat stdout as human logs.
8. `initialize({ cwd, provider, model, maxTokens? })`.
9. `session/prompt({ sessionId, contentBlocks: [{ type: "text", text: renderedPrompt }] })`.
10. For each `session.event`, write one JSONL line to `onLog("stdout")` for the UI parser; accumulate usage from `assistant/message.usage`; track last assistant text.
11. Stop on `session.status: idle` for that session (and owned subagent forest, matching the TS SDK).
12. `shutdown` + process teardown with `timeoutSec` / `graceSec`.
13. Return `AdapterExecutionResult`: exit/signal/timeout, `usage` (`usageBasis: "per_run"`), `sessionParams`, `sessionDisplayId`, `provider: "deepseek"`, `model`, `summary`, error family, `clearSession` if needed.
14. Remote `finally`: `restoreWorkspaceFromSshExecution` / existing no-remote-git helpers. Surface restore failure as a run error.

Prompt rendering uses the shared `renderPaperclipWakePrompt` / `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE` so wake-on-comment, recovery, and issue context match other local adapters.

Cancellation: Paperclip already SIGTERMs the child. On abort, close the JSON-RPC stdin and let the runtime dispose. Note the wire currently has **no per-prompt cancel method** (`packages/sdk/server/README.md`). Process kill is the cancel story, same class as a CLI adapter.

Hot-restart: do **not** add `deepseek_local` to the ACP stdio-bound restart list. JSON-RPC is a per-run subprocess (`processTopology: "detached"`).

---

## 8. Transcript mapping

Emit one JSON object per line. Keep the parser import-free (`docs/adapters/adapter-ui-parser.md`).

| `session.event` type | `TranscriptEntry.kind` |
|---|---|
| `assistant/chunk` (text) | `assistant` with `delta: true` |
| `assistant/chunk` (reasoning, if present) | `thinking` with `delta: true` |
| `assistant/message` | `assistant` (if not already fully streamed) + usage on `result` at idle |
| `tool/call` | `tool_call` (`name`, parsed `arguments`, `toolUseId: callId`) |
| `tool/result` | `tool_result` |
| `user/message` | `user` (optional; skip Paperclip-injected wake text if noisy) |
| `turn/end` reason `error` | `stderr` / result error |
| `session.status` idle + usage totals | `result` |
| `subagent.started` / `finished` | `system` |

CLI `format-event.ts` pretty-prints the same JSONL for `paperclipai run --watch`.

---

## 9. Environment test

`testEnvironment` checks, in order:

| Code | Level | What |
|---|---|---|
| `cli_detected` | error if missing | `dsh` or bundled `dsh-jsonrpc-agent` on PATH / configured `command` |
| `api_key` | error if missing | `DEEPSEEK_API_KEY` in layered env (adapter config, selected environment secret refs, process env) |
| `cwd` | error | absolute and creatable |
| `model` | info/warn | configured or `DSH_MODEL` / detected default |
| `hello_probe` | error on fail | JSON-RPC `initialize` + `session/prompt` with a throwaway session id and prompt `Respond with hello.`; timeout short (~30s) |
| `target` | info | host vs SSH vs sandbox label, same as Claude probe diagnostics |

Run the probe against `executionTarget` when present. Missing environment secret bindings must surface as `environment_env_binding_missing`, not a silent pass.

---

## 10. Skills and instructions

### Skills

- Paperclip-managed: `readPaperclipRuntimeSkillEntries` → copy/symlink into `<runDir>/skills/<name>/SKILL.md` (DeepSeek format: kebab-case name + description frontmatter; `packages/skill/skill-filesystem/README.md`).
- Native/external: list `~/.dsh/skills` and `~/.agents/skills` as `origin: "user_installed"` / `external_unknown`, read-only.
- `syncSkills` rewrites the materialized root; next execute picks it up. Do not mutate the operator’s `~/.dsh/skills` unless they opt in.
- `listSkills` returns the merged snapshot Claude’s helper already shapes (`buildRuntimeMountedSkillSnapshot`).

### Instructions

- `supportsInstructionsBundle: true`, `instructionsPathKey: "instructionsFilePath"`.
- Contents become the deployment persona (`DSH_SYSTEM_PROMPT`) plus the existing path-directive note Claude adds so `HEARTBEAT.md` / `SOUL.md` resolve from the instructions directory.
- Workspace `AGENTS.md` discovery is DeepSeek-native; do not also write Paperclip instructions into the repo cwd.

---

## 11. Config contract

```ts
export const type = "deepseek_local";
export const label = "DeepSeek Harness";
```

V1 `adapterConfig` fields:

| Field | Type | Default | Notes |
|---|---|---|---|
| `cwd` | string | workspace cwd | absolute fallback |
| `model` | string | `deepseek-v4-flash` (confirm against current catalog at implement time) | |
| `provider` | string | `deepseek-official` | JSON-RPC `initialize.provider` |
| `maxTokens` | number | provider default | `initialize.maxTokens` |
| `instructionsFilePath` | string | — | managed bundle |
| `promptTemplate` | string | shared Paperclip default | |
| `command` | string | auto (`dsh-jsonrpc-agent` or `dsh`) | |
| `persistSession` | boolean | true | |
| `timeoutSec` | number | 0 | |
| `graceSec` | number | 15 | |
| `extraArgs` | string[] | [] | forwarded only if using a CLI launcher wrapper |
| `env` | object | {} | secret refs allowed |
| `filesystemScope` / `filesystemExtraPaths` / `networkScope` / `networkAllowlist` | same as Claude | off | wrap runtime process |

Cheap profile: `{ model: "<flash-id>" }` under `runtimeConfig.modelProfiles.cheap`.

No `engine` field. If a future dsh ACP gains resume + tool streaming, add it then.

---

## 12. Implementation phases

### Phase 0 — Spike (1–2 days, local only)

- From the cloned harness repo, run the TS or Python SDK against `examples/jsonrpc-agent` with a real `DEEPSEEK_API_KEY` and a disposable workspace.
- Confirm: session id reuse continues the shell/conversation; `session.event` JSON contains `tool/call` + `assistant/message.usage`; stderr-only diagnostics.
- Record the exact published npm package names and versions (`@deepseek-ai/dsh-sdk-client`, runtime bin) in this plan’s changelog section.
- Decide: depend on published SDK vs vendored wire client.

Exit criterion: a 30-line script that performs two `run()` calls on one `sessionId` and prints usage + a tool name.

### Phase 1 — Plugin that can be hired and woken

- Package skeleton + `createServerAdapter()`.
- `execute` + `testEnvironment` + `sessionCodec` + config schema + configuration doc.
- Local-only JSON-RPC runtime, Paperclip env injection, prompt template, session persist.
- Generic stdout until Phase 2 parser lands.
- Register as **external-installable**; optionally skip built-in registration until Phase 2 if we want a thinner first PR. Preferred: register built-in immediately so QA uses the hire UI.

Exit criterion: create agent `adapterType: deepseek_local`, Test Environment passes, assign an issue, heartbeat completes, next heartbeat resumes the same `sessionId`.

### Phase 2 — Claude-visible product surfaces

- UI parser + CLI formatter (tool cards, thinking, result/usage).
- `listSkills` / `syncSkills` + materialized `customSkillDirs`.
- Instructions bundle.
- `listModels` / `refreshModels` / cheap profile / `detectModel`.
- Error family mapping + unknown-session rotate + `clearSession`.
- Host-list updates in section 4.2.
- Display registry + capability cold defaults.
- Docs: `docs/adapters/deepseek-local.md` + overview table row.

Exit criterion: run viewer shows tool cards and token totals; skills tab works; hire form shows DeepSeek next to Claude.

### Phase 3 — Remote / sandbox / confinement parity

- `getRuntimeCommandSpec` + sandbox install of `dsh` or the jsonrpc runtime bin.
- `prepareAdapterExecutionTargetRuntime` assets: cordis file, skills, session root, sanitized `DSH_HOME`.
- Workspace restore in `finally` (no `git push`).
- `filesystemScope` / `networkScope` around the runtime process.
- Remote env test / hello probe.

Exit criterion: same agent runs on local, SSH, and one sandbox provider; restore brings remote commits back; env test names the target.

### Phase 4 — Stretch (only if still short of “full”)

- `getQuotaWindows` if DeepSeek exposes a stable usage API.
- Runtime MCP injection if a dsh MCP plugin can be composed without breaking stdout purity.
- Optional `dsh` plugin that is a first-class Paperclip heartbeat citizen (reverse: start in dsh, create Paperclip work) — Hermes `paperclip-task-bridge` analog. Not required for Claude execute parity.

---

## 13. Core Paperclip touch list

Keep adapter logic in the new package. Core edits are registration and host lists only.

- `packages/shared/src/constants.ts` — `AGENT_ADAPTER_TYPES`
- `packages/shared/src/environment-support.ts` — remote managed set + tests
- `packages/adapter-utils/src/session-compaction.ts` — session management
- `server/src/adapters/builtin-adapter-types.ts`
- `server/src/adapters/registry.ts` — import `createServerAdapter` / named server exports
- `server/src/services/heartbeat.ts` — git-sensitive + sessioned sets
- `server/src/services/recovery/service.ts` — if applicable
- `ui/src/adapters/registry.ts`, `adapter-display-registry.ts`, `use-adapter-capabilities.ts`
- `ui/src/adapters/deepseek-local/` — thin UI module (parser + build-config)
- `cli/src/adapters/registry.ts`
- `docs/adapters/overview.md`, new `docs/adapters/deepseek-local.md`
- pnpm workspace / package manifest (do not commit `pnpm-lock.yaml` per `doc/DEVELOPING.md`)

Do **not** add `deepseek_local` to Claude setup-token routes, `CLAUDE_LOCAL_ADAPTER_TYPE` secret binding, or the ACP hot-restart list.

---

## 14. Tests

Adapter package (Vitest):

- `parse.test.ts` — fixture `session.event` streams → usage, summary, error families, transcript JSONL
- `session.test.ts` — codec; cwd/sessionRoot mismatch drops resume
- `skills.test.ts` — materialize SKILL.md frontmatter; merge native roots
- `execute.test.ts` — fake JSON-RPC child (stdio NDJSON) covering initialize, prompt, events, idle, shutdown
- `execute.remote.test.ts` — reuse adapter-utils execution-target test helpers
- `test.test.ts` — missing binary / missing key / probe failure
- `ui/parse-stdout.test.ts` + ui-parser contract (zero imports)

Host:

- `environment-support.test.ts` — `deepseek_local` supports local/ssh/sandbox
- `adapter-registry` / list adapters includes type and capabilities
- No e2e that calls real DeepSeek in CI. Optional manual `pnpm` script behind `DEEPSEEK_API_KEY`.

---

## 15. Verification

Phase 1 (local):

```sh
pnpm --filter @paperclipai/adapter-deepseek-harness test
pnpm --filter @paperclipai/adapter-deepseek-harness typecheck
# Paperclip running; adapter installed or built-in registered
curl -sS http://localhost:3100/api/adapters | jq '.[] | select(.type=="deepseek_local")'
# Hire agent, Test Environment, assign issue, inspect heartbeat_runs + session params
```

Phase 2+:

```sh
pnpm -r typecheck
pnpm test:run --filter adapter-deepseek
pnpm check:token-gates   # if UI files added
```

Manual: two consecutive heartbeats on one issue must log the same `sessionId` and the second run must see prior tool/file context. Run viewer must show tool cards, not a raw JSON blob.

---

## 16. Risks

| Risk | Mitigation |
|---|---|
| dsh is developer preview; wire and catalog ids will break | Pin versions; isolate protocol; fixture tests; README compatibility note |
| JSON-RPC has no prompt-level cancel | Kill the subprocess; honor `timeoutSec` / `graceSec` |
| Headless/ACP look simpler and will tempt a shortcut | This plan forbids them as the production path; Phase 0 must prove JSON-RPC resume |
| Host hardcoded lists omit a plugin-only install | V1 registers built-in + updates lists; later make lists capability-driven |
| Skills format / invocation frontmatter differs from Paperclip | Materialize a DeepSeek-valid `SKILL.md`; do not assume Claude `--add-dir` |
| Operator `~/.dsh` pollution | Paperclip-managed `DSH_SESSION_ROOT` and config dir; do not default to interactive home |
| stdout logger in a user-patched profile corrupts the protocol | Ship a closed `paperclip.cordis.yml`; ignore user web profile; document “do not add stdout plugins” |
| Runtime bin size / sandbox install time | `getRuntimeCommandSpec.installCommand` must be idempotent; cache on reusable sandbox leases |
| Token usage missing on some models | `usage` optional; do not fail the run; UI shows unknown |
| Quota/login parity gap vs Claude subscription UX | Explicit N/A: API key + env test. Do not fake a PTY login |

---

## 17. Recommended first PR slice

One PR that lands Phase 1 **and** the host type-list additions (so the adapter is selectable), with a raw-log UI. Follow with Phase 2 (parser + skills + models) and Phase 3 (remote) as separate PRs.

PR template must include Thinking Path, What Changed, Verification, Risks, Model Used, and the checklist (`.github/PULL_REQUEST_TEMPLATE.md`).

---

## 18. Phase 0 spike results (2026-08-29)

Closed from `/Users/mikestaub/code/codecrafters/ai-coding-tools/deepseek-harness` at adapter-plan time. dsh version in-tree: `0.1.1-rc.2`.

1. **Default model id:** `deepseek-v4-flash`. Confirmed in `python/sdk/README.md`, `packages/web/web-search-deepseek/src/provider.ts` (`DEEPSEEK_DEFAULT_MODEL`), and workflow tests. Pro / reasoner ids such as `deepseek-v4-pro` exist; cheap profile stays on flash.
2. **Published SDK vs owned client:** In-tree package.json uses `workspace:^` peers; published npm `0.1.1-rc.2` rewrites those to registry ranges, so the SDK **is** independently installable. **Decision remains: own thin NDJSON client** so Paperclip does not take a type dependency on `dsh-llm` / `dsh-session` / `cordis`. Isolation, not “unpublished peers.”
3. **TokenUsage → UsageSummary:** `packages/llm/llm/src/types.ts` — `{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`. Counts are disjoint: `inputTokens` is uncached input only. Map `cacheReadTokens` → `cachedInputTokens`. Ignore `cacheWriteTokens` / `reasoningTokens` in V1 totals (they are not Paperclip `UsageSummary` fields).
4. **Unattended policy:** mount `@deepseek-ai/dsh-sandbox-policy` with `mode: danger-full-access` (default is fail-safe `read-only`). The shipped `examples/jsonrpc-agent/cordis.yml` does not mount this plugin; Paperclip’s composition must, so heartbeats do not block on file/bash approval. There is no separate Claude-style `--dangerously-skip-permissions` flag.
5. **Runtime install:** `dsh-jsonrpc-agent` is the JSON-RPC bin (`@deepseek-ai/dsh-sdk-jsonrpc-demo`). It **does not** ship the plugin tree; it boots `$DSH_CORDIS_CONFIG` / argv and resolves bare plugins from the **configuration project**. `npm install -g @deepseek-ai/dsh-sdk-jsonrpc-demo` alone is not a working runtime. Operators need a DeepSeek Harness install (source checkout, `@deepseek-ai/dsh`, or the Python `deepseek-harness-runtime-bin` closed exe). Paperclip ships `paperclip.cordis.yml` and sets `NODE_PATH` to `harnessRoot/node_modules` when `adapterConfig.harnessRoot` is set. Always pass `DSH_CORDIS_CONFIG`. `getRuntimeCommandSpec.installCommand` stays `null` unless a closed runtime bin is on PATH.

**SDK client decision recorded:** own protocol types + NDJSON client. Pin compatibility notes to dsh `0.1.1-rc.2` wire: `initialize`, `session/prompt`, `shutdown` + notifications `session.event`, `session.status`, `subagent.started`, `subagent.finished`. `serverInfo.name` is `deepseek-harness-sdk-runtime`.

**Live API spike:** not run in this session (no `DEEPSEEK_API_KEY` required for the protocol mock). `scripts/deepseek-jsonrpc-session-spike.mjs` proves two `session/prompt` calls on one `sessionId` against a mock runtime and prints usage + a tool name.

### Watchdog

`scripts/monitor-deepseek-adapter-session.sh` checks git/file/heartbeat freshness. A 20-minute agent loop ticks `AGENT_LOOP_TICK_deepseek_adapter`. Heartbeat file: `.ai/deepseek-adapter-session/heartbeat.json`.

## 19. Phase 1 results (2026-08-29)

Shipped `@paperclipai/adapter-deepseek-harness` and registered `deepseek_local` as a built-in.

- Owned NDJSON client + `subscribe` **before** `session/prompt`, then inbox receipt (`agent/inbox/spliced` + `inserted[].id === messageId`) then `session.status === idle`.
- `installCommand` is `null`. README documents the plugin+cordis+`harnessRoot` closure.
- Host lists updated for hire/wake/session resume (not remote-managed; that is Phase 3).
- Env test fails closed without `DEEPSEEK_API_KEY`. Hello probe is local-only.
- Tests use a protocol-accurate mock runtime. Live `DEEPSEEK_API_KEY` heartbeat was not run.

## 20. Phase 2 results (2026-08-29)

- UI parser + CLI formatter map `paperclipDeepseek` JSONL to tool cards, thinking, assistant text, and result.
- `listSkills` / `syncSkills` materialize desired Paperclip skills into `$PAPERCLIP_HOME/adapter-state/.../deepseek/skills` and set `DSH_BUNDLED_SKILL_DIR`.
- Curated models + cheap profile + `detectModel` (`DSH_MODEL` or `~/.dsh/config.yaml`).
- Docs: `docs/adapters/deepseek-local.md` and overview table row.
- Phase 1 review must-fixes: transport death rejects waiters; initialize is bounded; idle-before-inbox is tested.

### Phase 2 review follow-up (official wire)

Parser and turn accounting now match dsh `0.1.1-rc.2` `SessionEventMap` / `StreamChunk` / `ToolResultMessage`:

- `assistant/chunk.data.chunk` is `text-delta` / `reasoning-delta` / `usage` (not a invented `{ type, text }` block).
- `tool/call.arguments` is a JSON string; `tool/result` content is `data.message.content[0]` (`type: tool-result`, `toolCallId`).
- `turn/end.reason` is `{ kind, error? }` (`LlmFailure`), including `max-tokens`.
- `createStdoutParser` accumulates usage; idle result uses `assistant/message.usage` when present and falls back to chunk usage so the run-viewer card is not hardcoded zeros. Message and chunk usage are not double-counted.
- `materializeDeepseekSkills` rewrites the materialized root (deselected siblings are deleted).
- Instructions append the Claude-equivalent HEARTBEAT.md / SOUL.md path directive.

## 21. Phase 3 results (2026-08-29)

- `deepseek_local` is in `REMOTE_MANAGED_ADAPTERS` (local / SSH / sandbox).
- Remote execute uploads a Paperclip-owned one-shot JSON-RPC bridge because execution targets only accept one-shot stdin. The bridge implements subscribe → `session/prompt` → inbox receipt → idle and prints `paperclipDeepseek` JSONL plus `bridge-result`.
- Assets: shipped Cordis file, bridge script, session root, materialized skills. `installCommand` stays `null`.
- Workspace restore runs in `finally`. Restore failure fails the run.
- Local Linux `filesystemScope` / `networkScope` wrap the JSON-RPC runtime via `buildLocalProcessSandboxSpawnTarget`.
- Remote env test uses the same bridge after `prepareAdapterExecutionTargetRuntime`.
- `sessionCodec` preserves `remoteExecution` so heartbeat serialize/deserialize does not drop SSH/sandbox resume identity.

## 22. Phase 4 (deferred)

Not implemented in this branch. There is no stable DeepSeek quota API for `getQuotaWindows`. JSON-RPC MCP would require a stdout-safe plugin composition. A Hermes-style reverse task-bridge is out of scope for Claude execute parity.
