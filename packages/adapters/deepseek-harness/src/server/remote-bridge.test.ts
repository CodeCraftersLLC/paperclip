import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBridgeStdout } from "./parse.js";
import { resolveDeepseekRemoteBridgePath } from "./remote-bridge-path.js";

const mockRuntime = fileURLToPath(new URL("./mock-jsonrpc-runtime.mjs", import.meta.url));

describe("remote-bridge", () => {
  it("drives a mock JSON-RPC runtime over one-shot stdin and emits a bridge-result", async () => {
    const child = spawn(process.execPath, [resolveDeepseekRemoteBridgePath()], {
      env: {
        ...process.env,
        DSH_JSONRPC_COMMAND: process.execPath,
        DSH_JSONRPC_ARGS: JSON.stringify([mockRuntime]),
        DSH_SESSION_ID: "paperclip-dsh-bridge-test",
        DSH_CWD: path.dirname(mockRuntime),
        DSH_TIMEOUT_MS: "5000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stdin.end("Hello from the remote bridge.\n");
    const [code] = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("remote bridge test timed out")), 8_000);
      }),
    ]);
    expect(code).toBe(0);
    const parsed = parseBridgeStdout(stdout);
    expect(parsed.summary).toMatch(/^ack /);
    expect(parsed.toolName).toBe("bash");
    expect(parsed.usage).toEqual({ inputTokens: 22, outputTokens: 8, cachedInputTokens: 4 });
    expect(parsed.errorMessage).toBeNull();
  }, 10_000);
});
