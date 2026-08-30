import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../shared/constants.js";
import { detectModel } from "./models.js";

const originalModel = process.env.DSH_MODEL;
const originalProvider = process.env.DSH_PROVIDER;
const originalHome = process.env.DSH_HOME;

afterEach(() => {
  if (originalModel === undefined) delete process.env.DSH_MODEL;
  else process.env.DSH_MODEL = originalModel;
  if (originalProvider === undefined) delete process.env.DSH_PROVIDER;
  else process.env.DSH_PROVIDER = originalProvider;
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
});

describe("detectModel", () => {
  it("prefers DSH_MODEL over local yaml", async () => {
    process.env.DSH_MODEL = "deepseek-v4-pro";
    process.env.DSH_PROVIDER = "deepseek-official";
    const detected = await detectModel();
    expect(detected).toMatchObject({
      model: "deepseek-v4-pro",
      provider: "deepseek-official",
      source: "DSH_MODEL",
    });
  });

  it("reads ~/.dsh/config.yaml when DSH_MODEL is unset", async () => {
    delete process.env.DSH_MODEL;
    delete process.env.DSH_PROVIDER;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-model-"));
    process.env.DSH_HOME = home;
    await fs.writeFile(
      path.join(home, "config.yaml"),
      "provider: deepseek-official\nmodel: deepseek-v4-pro\n",
      "utf8",
    );
    const detected = await detectModel();
    expect(detected).toMatchObject({
      model: "deepseek-v4-pro",
      provider: "deepseek-official",
      source: `${home}/config.yaml`,
    });
    await fs.rm(home, { recursive: true, force: true });
  });

  it("falls back to the adapter default", async () => {
    delete process.env.DSH_MODEL;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-model-"));
    process.env.DSH_HOME = home;
    const detected = await detectModel();
    expect(detected).toMatchObject({
      model: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
      source: "adapter_default",
    });
    await fs.rm(home, { recursive: true, force: true });
  });
});
