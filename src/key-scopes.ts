export const publishableKeyScopes = ["data:read", "files:read"] as const;

export const secretKeyScopes = [
  ...publishableKeyScopes,
  "data:write",
  "files:write",
  "project:admin",
] as const;

export const initialPublishableKeyScopes = [...publishableKeyScopes] as const;
export const initialSecretKeyScopes = ["project:admin"] as const;
