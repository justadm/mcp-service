import { describe, expect, it } from "vitest";
import { renderComposeYaml, renderProjectYaml, validateProjectId } from "../init.js";

describe("init", () => {
  it("validates project id", () => {
    expect(() => validateProjectId("")).toThrow();
    expect(() => validateProjectId("A")).toThrow();
    expect(() => validateProjectId("ok-1")).not.toThrow();
  });

  it("renders mysql project yaml with defaults", () => {
    const yml = renderProjectYaml({ id: "my1", type: "mysql" });
    expect(yml).toContain("type: mysql");
    expect(yml).toContain("connectionStringEnv: MYSQL_CONNECTION_STRING");
    expect(yml).toContain("path: /p/my1/mcp");
  });

  it("renders json project yaml + compose with managed data file", () => {
    const project = renderProjectYaml({ id: "j2", type: "json", json: { file: "data/j2.json" } });
    expect(project).toContain("type: json");
    expect(project).toContain("file: /app/data.json");

    const compose = renderComposeYaml({ id: "j2", type: "json", json: { file: "data/j2.json" }, hostPort: 19055 });
    expect(compose).toContain("127.0.0.1:19055:8080");
    expect(compose).toContain("./data/j2.json:/app/data.json:ro");
  });
});
