import { describe, it, expect } from "vitest";
import { AppConfig } from "../config.js";

describe("AppConfig", () => {
  it("парсит минимальную конфигурацию", () => {
    const cfg = AppConfig.parse({
      server: { name: "x", version: "1" },
      sources: [{ id: "a", type: "json", file: "examples/demo.json" }],
    });
    expect(cfg.server.name).toBe("x");
    expect(cfg.sources[0]?.type).toBe("json");
  });

  it("парсит postgres источник", () => {
    const cfg = AppConfig.parse({
      server: { name: "x", version: "1" },
      sources: [
        {
          id: "pg1",
          type: "postgres",
          connectionString: "postgresql://u:p@localhost:5432/db",
          schema: "public",
          allowTables: ["public.users"],
          maxLimit: 500,
        },
      ],
    });
    expect(cfg.sources[0]?.type).toBe("postgres");
  });
});
