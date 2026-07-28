import { createHash, randomBytes, randomUUID } from "node:crypto";

const token = `mb_management_${randomBytes(32).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const id = randomUUID();
const createdAt = new Date().toISOString();
const sql = [
  "INSERT INTO management_keys",
  "  (id, name, key_hash, scopes, created_at)",
  `VALUES ('${id}', 'initial owner key', '${hash}', 'projects:write,keys:write,audit:read', '${createdAt}');`,
].join("\n");

console.log("Store this key once in a trusted password manager; it cannot be recovered:");
console.log(token);
console.log("\nApply this SQL only to the control-plane D1 database:");
console.log(sql);
