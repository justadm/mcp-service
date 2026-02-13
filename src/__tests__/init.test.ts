import { describe, expect, it } from "vitest";
import { renderProjectYaml, validateProjectId } from "../init.js";

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
});

