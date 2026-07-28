export interface PostgresColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey?: boolean;
  default?: string;
}

export interface PostgresTable {
  schema: string;
  name: string;
  columns: PostgresColumn[];
}

export interface SqliteTransform {
  sql: string;
  warnings: string[];
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const quote = (value: string): string => {
  if (!identifierPattern.test(value)) throw new Error("unsafe_identifier");
  return `"${value}"`;
};

export function mapPostgresType(type: string): { sqlite: string; warning?: string } {
  const normalized = type.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.endsWith("[]")) return { sqlite: "TEXT", warning: `array ${type} stored as JSON text` };
  if (/^(uuid|text|character varying|varchar|character|char)(\(\d+\))?$/.test(normalized)) return { sqlite: "TEXT" };
  if (/^(smallint|integer|int|bigint|smallserial|serial|bigserial)$/.test(normalized)) return { sqlite: "INTEGER" };
  if (/^(boolean|bool)$/.test(normalized)) return { sqlite: "INTEGER CHECK_VALUE_BOOLEAN" };
  if (/^(numeric|decimal)(\(.+\))?$/.test(normalized)) {
    return { sqlite: "REAL", warning: `${type} may lose arbitrary precision` };
  }
  if (/^(real|double precision|float)(\(.+\))?$/.test(normalized)) return { sqlite: "REAL" };
  if (/^(json|jsonb)$/.test(normalized)) return { sqlite: "TEXT CHECK_VALUE_JSON" };
  if (/^(timestamp|timestamp with time zone|timestamp without time zone|timestamptz|date|time.*)$/.test(normalized)) {
    return { sqlite: "TEXT" };
  }
  if (normalized === "bytea") return { sqlite: "BLOB" };
  throw new Error(`unsupported_postgres_type:${type}`);
}

function mapDefault(value: string | undefined, warnings: string[], column: string): string {
  if (!value) return "";
  const normalized = value.trim().replace(/::[A-Za-z0-9_ ]+$/, "");
  if (/^(now\(\)|current_timestamp)$/i.test(normalized)) return " DEFAULT (datetime('now'))";
  if (/^(true|false)$/i.test(normalized)) return ` DEFAULT ${normalized.toLowerCase() === "true" ? 1 : 0}`;
  if (/^-?\d+(\.\d+)?$/.test(normalized)) return ` DEFAULT ${normalized}`;
  if (/^'.*'$/.test(normalized) && !normalized.includes(";")) return ` DEFAULT ${normalized}`;
  warnings.push(`${column}: default ${value} omitted`);
  return "";
}

export function transformPostgresTable(table: PostgresTable): SqliteTransform {
  if (table.schema !== "public") throw new Error("unsupported_postgres_schema");
  if (table.columns.length === 0) throw new Error("table_requires_columns");
  const warnings: string[] = [];
  const columns = table.columns.map((column) => {
    const mapped = mapPostgresType(column.type);
    if (mapped.warning) warnings.push(`${column.name}: ${mapped.warning}`);
    const booleanCheck = mapped.sqlite === "INTEGER CHECK_VALUE_BOOLEAN"
      ? ` CHECK (${quote(column.name)} IN (0, 1))` : "";
    const jsonCheck = mapped.sqlite === "TEXT CHECK_VALUE_JSON"
      ? ` CHECK (json_valid(${quote(column.name)}))` : "";
    const sqliteType = mapped.sqlite.split(" ")[0];
    return [
      quote(column.name), ` ${sqliteType}`,
      column.primaryKey ? " PRIMARY KEY" : "",
      column.nullable || column.primaryKey ? "" : " NOT NULL",
      booleanCheck,
      jsonCheck,
      mapDefault(column.default, warnings, column.name),
    ].join("");
  });
  return {
    sql: `CREATE TABLE ${quote(table.name)} (\n  ${columns.join(",\n  ")}\n);`,
    warnings,
  };
}

export function transformPostgresValue(type: string, value: unknown): unknown {
  if (value === null) return null;
  const normalized = type.toLowerCase().trim();
  if (normalized === "boolean" || normalized === "bool") {
    if (typeof value !== "boolean") throw new Error("invalid_boolean_value");
    return value ? 1 : 0;
  }
  if (normalized === "json" || normalized === "jsonb" || normalized.endsWith("[]")) {
    return JSON.stringify(value);
  }
  if (normalized === "bytea") {
    if (typeof value !== "string" || !/^\\x[a-fA-F0-9]*$/.test(value) || value.length % 2 !== 0) {
      throw new Error("invalid_bytea_value");
    }
    return Uint8Array.from(value.slice(2).match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  }
  if (/^(timestamp|timestamptz|date|time)/.test(normalized)) {
    if (typeof value !== "string") throw new Error("invalid_temporal_value");
    return value;
  }
  return value;
}
