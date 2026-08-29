import type { UIAdapterModule } from "../types";
import { parseDeepseekStdoutLine, createDeepseekStdoutParser, buildDeepseekConfig } from "@paperclipai/adapter-deepseek-harness/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const deepseekLocalUIAdapter: UIAdapterModule = {
  type: "deepseek_local",
  label: "DeepSeek Harness",
  parseStdoutLine: parseDeepseekStdoutLine,
  createStdoutParser: createDeepseekStdoutParser,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildDeepseekConfig,
};
