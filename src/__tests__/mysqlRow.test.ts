import { describe, expect, it } from "vitest";
import { mysqlPickRowValue } from "../connectors/mysqlRow.js";

describe("mysqlPickRowValue", () => {
  it("reads from object with lowercase key", () => {
    expect(mysqlPickRowValue({ table_name: "users" }, ["table_name", "TABLE_NAME"], 0)).toBe(
      "users",
    );
  });

  it("reads from object with uppercase key", () => {
    expect(mysqlPickRowValue({ TABLE_NAME: "users" }, ["table_name", "TABLE_NAME"], 0)).toBe(
      "users",
    );
  });

  it("reads from array rows", () => {
    expect(mysqlPickRowValue(["users"], ["table_name", "TABLE_NAME"], 0)).toBe("users");
  });

  it("passes through scalar rows", () => {
    expect(mysqlPickRowValue("users", ["table_name", "TABLE_NAME"], 0)).toBe("users");
  });
});

