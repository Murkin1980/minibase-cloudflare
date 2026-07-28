import type { CloudflareResponse, D1HttpQueryResult, MiniBaseEnv } from "./contracts";

export async function queryProjectD1<T>(
  env: MiniBaseEnv,
  databaseId: string,
  sql: string,
  params: unknown[],
): Promise<D1HttpQueryResult<T>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_D1_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const payload = await response.json() as CloudflareResponse<Array<D1HttpQueryResult<T>>>;
  const result = payload.result?.[0];
  if (!response.ok || !payload.success || !result?.success) throw new Error("cloudflare_api_error");
  return result;
}
