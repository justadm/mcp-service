import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../init.js";

describe("runInit", () => {
  it("is idempotent when output files already exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-service-init-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(tmp);
      fs.mkdirSync(path.join(tmp, "deploy"), { recursive: true });

      const r1 = runInit({
        id: "demo1",
        type: "json",
        updateEnvExample: false,
        updateNginxConf: false,
      });
      expect(fs.existsSync(r1.outProjectFile)).toBe(true);
      expect(fs.existsSync(r1.outComposeFile)).toBe(true);

      const project1 = fs.readFileSync(r1.outProjectFile, "utf8");
      const compose1 = fs.readFileSync(r1.outComposeFile, "utf8");

      // Second run should not throw and should keep the same projectPath/hostPort
      const r2 = runInit({
        id: "demo1",
        type: "json",
        updateEnvExample: false,
        updateNginxConf: false,
      });

      expect(r2.projectPath).toBe(r1.projectPath);
      expect(r2.hostPort).toBe(r1.hostPort);

      const project2 = fs.readFileSync(r2.outProjectFile, "utf8");
      const compose2 = fs.readFileSync(r2.outComposeFile, "utf8");
      expect(project2).toBe(project1);
      expect(compose2).toBe(compose1);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

