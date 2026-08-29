---
"@topaz-ia/pump-evolution": minor
---

`ManagedAgentClient.invoke` (Node) / `ManagedAgentClient.invoke` (Python) now
accept an optional per-invocation model override.

- New optional field `modelId` (Node, `ManagedAgentInvocation`) / `model_id`
  (Python, `invoke(...)` keyword arg) — lets an external agent pick dynamically,
  per call, among the models enabled in the tenant's Tooling-account catalog
  instead of always using the agent's fixed registered model. Serialized on the
  wire as `modelId` in both SDKs for parity.
- The platform validates the override fail-closed against the tenant's model
  allowlist: an out-of-allowlist `modelId` rejects the request
  (`ManagedAgentInvokeError`) — it never silently falls back to the agent's
  default model. There is no way to route to a model outside the Tooling
  account's catalog (no "bring your own model").
- `ManagedAgentResult` (Node) / `ManagedAgentResult` (Python) now also expose
  `modelId` / `model_id` — the model actually used for the invocation (the
  override, when provided, or the agent's fixed default).
- Fully backward-compatible: omitting `modelId`/`model_id` preserves the exact
  current behavior (the agent's fixed registered model).
