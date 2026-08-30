---
"@topaz-ia/pump-evolution": minor
---

Cognito login can now be declared in the manifest and read by the SDK.

- New manifest block `runtime.cognito` (`ManifestCognito` type): non-secret
  end-user login config (`domain`, `clientId`, `redirectUri`, optional `scopes`
  and `logoutRedirectUri`) that the portal/MCP provisions and writes into the
  manifest. The client secret is never stored in the manifest.
- New `CognitoLogin.fromManifest(source, options?)` (Node) /
  `CognitoLogin.from_manifest(source, ...)` (Python): builds the login wiring
  straight from `runtime.cognito`, merging `COGNITO_CLIENT_SECRET` from the
  environment for confidential App Clients. Throws (zero fallback) when the
  manifest has no `runtime.cognito` block.

The developer no longer copies `COGNITO_*` env vars by hand: the SDK reads the
manifest. `CognitoLogin.fromEnv()`/`from_env()` remain as the env-based path.

Symmetric managed-runtime support was added the same way:

- New manifest block `runtime.managed` (`ManifestManagedRuntime` type): non-secret
  managed-runtime wiring (`endpoint`, `agentId`, `tokenUrl`, optional `scope`) that
  the portal/MCP writes when an external agent opts into the platform's managed
  runtime. The invoke credential is never stored in the manifest.
- New `ManagedAgentClient.fromManifest(source, options?)` (Node) /
  `ManagedAgentClient.from_manifest(source, ...)` (Python): builds the client from
  `runtime.managed`, merging `PUMP_MANAGED_CLIENT_ID` / `PUMP_MANAGED_CLIENT_SECRET`
  from the environment. Throws (zero fallback) when `runtime.managed` is absent.
  `ManagedAgentClient.fromEnv()`/`from_env()` remain as the env-based path.

Available models are now surfaced from the manifest too:

- New manifest block `runtime.models` (`ManifestModel[]`): a portal-written snapshot
  of the account's enabled Bedrock catalog (`modelId`, optional `name`/`provider`/
  `streaming`). It is a live snapshot rewritten at install/update — not a
  hand-maintained static list. The SDK parses and surfaces it to the developer;
  authoritative availability still lives behind the platform API / managed runtime.
