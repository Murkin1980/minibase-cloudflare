const baseUrl = process.env.MINIBASE_URL ?? "https://minibase-cloudflare.muriktl.workers.dev";
const managementKey = process.env.MINIBASE_MANAGEMENT_KEY;

if (!managementKey?.match(/^mb_management_[a-f0-9]{64}$/)) {
  throw new Error("MINIBASE_MANAGEMENT_KEY must be supplied through the environment");
}

const health = await fetch(`${baseUrl}/health`);
if (!health.ok) throw new Error(`health_failed:${health.status}`);
const healthBody = await health.json();
if (healthBody.service !== "minibase" || healthBody.status !== "ok") {
  throw new Error("health_contract_failed");
}

const audit = await fetch(`${baseUrl}/v1/audit-events?limit=1`, {
  headers: { authorization: `Bearer ${managementKey}` },
});
if (!audit.ok) throw new Error(`management_smoke_failed:${audit.status}`);
const auditBody = await audit.json();
if (!auditBody || typeof auditBody !== "object") throw new Error("audit_contract_failed");

process.stdout.write(JSON.stringify({
  status: "passed",
  serviceVersion: healthBody.version,
  healthRequestId: health.headers.get("x-minibase-request-id"),
  auditRequestId: audit.headers.get("x-minibase-request-id"),
}, null, 2) + "\n");
