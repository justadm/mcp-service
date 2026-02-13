import type { SourceConfig } from "../config.js";
import type { Connector } from "./types.js";
import { createOpenApiConnector } from "./openapi.js";
import { createCsvConnector } from "./csv.js";
import { createJsonConnector } from "./json.js";
import { createPostgresConnector } from "./postgres.js";

export function createConnector(cfg: SourceConfig): Connector {
  switch (cfg.type) {
    case "openapi":
      return createOpenApiConnector(cfg);
    case "csv":
      return createCsvConnector(cfg);
    case "json":
      return createJsonConnector(cfg);
    case "postgres":
      return createPostgresConnector(cfg);
    default: {
      const _exhaustive: never = cfg;
      return _exhaustive;
    }
  }
}
