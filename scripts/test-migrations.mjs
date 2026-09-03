import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

/**
 * Control-plane migration contract.
 *
 * Wrangler applies these files in filename order exactly once and records them
 * in its own `d1_migrations` table, so the guarantees that matter are: strict
 * numeric ordering, uniqueness, contiguity, and no destructive statement. A
 * production schema must never change without a migration record, and an applied
 * migration must never be edited afterwards.
 *
 * This lives in `scripts/` rather than `src/` because `src` is intentionally
 * typed as a Worker bundle with no Node type environment.
 */

const directory = new URL("../migrations/", import.meta.url);
const namePattern = /^(\d{4})_([a-z0-9_]+)\.sql$/;

const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
assert.ok(names.length > 0, "no migration files found");

const migrations = [];
for (const name of names) {
  const match = namePattern.exec(name);
  assert.ok(match, `unexpected migration filename: ${name}`);
  migrations.push({
    name,
    number: Number(match[1]),
    sql: await readFile(new URL(name, directory), "utf8"),
  });
}

const numbers = migrations.map((migration) => migration.number);
assert.deepEqual(numbers, [...numbers].sort((left, right) => left - right), "migrations are not ordered");
assert.equal(new Set(numbers).size, numbers.length, "duplicate migration numbers");
assert.deepEqual(numbers, numbers.map((_, index) => index + 1), "migration numbering is not contiguous from 0001");

for (const { name, sql } of migrations) {
  assert.ok(!/\b(DROP|TRUNCATE)\b/i.test(sql), `${name} contains a destructive statement`);
  assert.ok(!/\bDELETE\s+FROM\b/i.test(sql), `${name} deletes rows`);
  assert.ok(sql.trimStart().startsWith("PRAGMA foreign_keys = ON;"), `${name} does not enforce foreign keys`);
}

const added = new Set();
for (const { name, sql } of migrations) {
  for (const match of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) {
    const signature = `${match[1]}.${match[2]}`;
    assert.ok(!added.has(signature), `${name} re-adds ${signature}`);
    added.add(signature);
  }
}

const audit = migrations.find((migration) => migration.name.startsWith("0007_"));
assert.ok(audit, "expected 0007_audit_contract.sql");
for (const column of ["entity", "entity_id", "correlation_id"]) {
  assert.ok(
    audit.sql.includes(`ALTER TABLE audit_events ADD COLUMN ${column} TEXT`),
    `0007 does not add audit_events.${column}`,
  );
}
assert.ok(audit.sql.includes("CREATE INDEX audit_events_correlation_idx"), "missing correlation index");

process.stdout.write(
  `Migration contract verified: ${migrations.length} files, ordered 0001-${String(numbers.at(-1)).padStart(4, "0")}, ` +
  `non-destructive, audit contract present\n`,
);
