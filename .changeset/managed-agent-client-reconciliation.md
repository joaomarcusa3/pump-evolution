---
"@topaz-ia/pump-evolution": minor
---

Reconciles the `ManagedAgentClient` (managed-runtime hosting for external
agents, ADR-0068) with the Cognito/MCP/versioning work merged separately into
`main` (!15–!22).

`ManagedAgentClient` had been built and tested against the platform's real
`/api/agents/:agentId/invoke` contract, but never made it into the same branch
as the Cognito login rework, the MCP low-level `Server` instrumentation fix, and
the publish-pipeline hardening. This release reunites both lines of work:

- `ManagedAgentClient` (Node) / `ManagedAgentClient` (Python) — invoke an agent
  hosted on the platform's managed AgentCore runtime instead of running your own
  runtime. `fromEnv()` / `from_env()`, `forAgent()` / `for_agent()`, and
  `fromManifest()` / `from_manifest()` (reads `runtime.managed` from the
  manifest, mirroring how `CognitoLogin.fromManifest` reads `runtime.cognito`).
- New manifest blocks `runtime.managed` (`ManifestManagedRuntime`) and
  `runtime.models` (`ManifestModel[]`), parsed by `ManifestLoader` alongside the
  existing `runtime.telemetry` and `runtime.cognito` blocks. `runtime.models` is
  a portal-written snapshot of the tenant's enabled Bedrock catalog — not a
  hand-maintained list.
- No behavioral change to any of the Cognito, MCP, or publish-pipeline work
  already on `main` — this is a pure addition alongside it.
