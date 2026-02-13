export function mysqlPickRowValue(
  row: unknown,
  keyCandidates: string[],
  arrayIndex = 0,
): unknown {
  if (row === null || row === undefined) return undefined;

  // Some mysql2 configs can return scalar/array rows (e.g. rowsAsArray).
  if (
    typeof row === "string" ||
    typeof row === "number" ||
    typeof row === "boolean"
  ) {
    return row;
  }

  if (Array.isArray(row)) return row[arrayIndex];

  if (typeof row === "object") {
    const obj = row as Record<string, unknown>;
    for (const k of keyCandidates) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
    }
  }

  return undefined;
}

export function mysqlPickRowValueRequired(
  row: unknown,
  keyCandidates: string[],
  arrayIndex = 0,
  label = "value",
): unknown {
  const v = mysqlPickRowValue(row, keyCandidates, arrayIndex);
  if (v === null || v === undefined) {
    const keys = keyCandidates.join("|");
    throw new Error(`Не удалось прочитать ${label} из row (keys=${keys}, idx=${arrayIndex})`);
  }
  return v;
}
