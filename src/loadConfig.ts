import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { AppConfig } from "./config.js";
import { resolveSecrets } from "./secrets.js";

export function loadConfigFile(configPath: string) {
  const abs = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);
  const raw = fs.readFileSync(abs, "utf8");

  // YAML умеет читать JSON как подмножество.
  const parsed = YAML.parse(raw);
  const cfg = AppConfig.parse(parsed);
  return resolveSecrets(cfg);
}
