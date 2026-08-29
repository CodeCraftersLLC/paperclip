import { describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

describe("testEnvironment", () => {
  it("fails closed when DEEPSEEK_API_KEY is missing", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "deepseek_local",
      config: {
        command: process.execPath,
        cwd: process.cwd(),
      },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "api_key" && check.level === "error")).toBe(true);
  });

  it("reports a missing JSON-RPC command", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "deepseek_local",
      config: {
        command: "definitely-not-a-dsh-binary",
        cwd: process.cwd(),
        env: { DEEPSEEK_API_KEY: "test-key" },
      },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "cli_detected" && check.level === "error")).toBe(true);
  });
});
