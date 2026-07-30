/**
 * Attribute-name constants used across the SDK.
 *
 * These are the literal OpenTelemetry GenAI semantic-convention attribute names
 * plus the `cta.*` custom attributes the CTA receiver understands. They are
 * defined here (rather than imported) so the constant set is explicit and stable
 * regardless of the semantic-conventions package version.
 */

// ─── GenAI semantic conventions ───────────────────────────────────────────────

export const GEN_AI_AGENT_ID = 'gen_ai.agent.id' as const;
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model' as const;
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens' as const;
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens' as const;
export const GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name' as const;
export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name' as const;
export const GEN_AI_TOOL_NAME = 'gen_ai.tool.name' as const;
export const GEN_AI_SESSION_ID = 'gen_ai.session.id' as const;
export const GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons' as const;

// ─── Standard OTel attributes reused by the SDK ────────────────────────────────

export const SERVICE_NAME = 'service.name' as const;
export const ENDUSER_ID = 'enduser.id' as const;

// ─── CTA custom attributes ─────────────────────────────────────────────────────

export const CTA_COST_CENTER = 'cta.cost_center' as const;
export const CTA_SQUAD = 'cta.squad' as const;
export const CTA_DATA_CLASSIFICATION = 'cta.data_classification' as const;
export const CTA_RISK_TIER = 'cta.risk_tier' as const;
export const CTA_ALLOWED_TOOLS = 'cta.allowed_tools' as const;
export const CTA_DEPARTMENT = 'cta.department' as const;
export const CTA_COMPLIANCE_STATUS = 'cta.compliance.status' as const;
export const CTA_COMPLIANCE_FINDINGS = 'cta.compliance.findings' as const;
export const CTA_IDENTITY_ANONYMOUS = 'cta.identity.anonymous' as const;

/**
 * Item kind the telemetry describes: `agent` (LLM-backed) or `mcp` (Model
 * Context Protocol server — a governed tool provider, no model of its own).
 * Lets the CTA receiver dimension agents vs MCP servers in the same pipeline.
 */
export const CTA_ITEM_KIND = 'cta.item_kind' as const;

// ─── CTA security attributes (OWASP LLM Top 10 — runtime) ─────────────────────

/** `secure` | `at_risk` — the invocation's runtime security posture. */
export const CTA_SECURITY_STATUS = 'cta.security.status' as const;
/** JSON array (string) of `SecurityFinding` objects (redacted — no raw values). */
export const CTA_SECURITY_FINDINGS = 'cta.security.findings' as const;
/** Distinct OWASP LLM categories present, for server-side metric dimensioning. */
export const CTA_SECURITY_OWASP_CATEGORIES = 'cta.security.owasp_categories' as const;

/**
 * Explicit marker for token-count availability on an invocation span.
 *
 * When a Bedrock response exposes usage, this is `true` and the
 * `gen_ai.usage.*` attributes are set. When the response does NOT expose token
 * counts, this is `false` and the `gen_ai.usage.*` attributes are OMITTED —
 * never set to `0`. A fabricated `0` would silently corrupt cost aggregation
 * downstream; the explicit `false` records absence honestly (Requirement 3.3,
 * "nunca fabricar métrica — ausência é ausência explícita").
 */
export const CTA_USAGE_TOKENS_AVAILABLE = 'cta.usage.tokens_available' as const;

// ─── Well-known attribute values ───────────────────────────────────────────────

/** `gen_ai.provider.name` value for Amazon Bedrock. */
export const PROVIDER_AWS_BEDROCK = 'aws.bedrock' as const;

/** `gen_ai.operation.name` value for a tool execution span. */
export const OPERATION_EXECUTE_TOOL = 'execute_tool' as const;

/**
 * `gen_ai.operation.name` value for a chat/conversation invocation. Used for the
 * Bedrock `Converse` / `ConverseStream` operations (GenAI semconv).
 */
export const OPERATION_CHAT = 'chat' as const;

/**
 * `gen_ai.operation.name` value for a raw text-completion invocation. Used for
 * the Bedrock `InvokeModel` / `InvokeModelWithResponseStream` operations, whose
 * payload is model-native rather than the normalized Converse message shape.
 */
export const OPERATION_TEXT_COMPLETION = 'text_completion' as const;

/** `source` discriminator for usage events produced by this SDK. */
export const USAGE_SOURCE_EXTERNAL_OTEL = 'external-otel' as const;

// ─── Environment / config ──────────────────────────────────────────────────────

/** Environment variable that gates the SDK. Only `'true'` enables it. */
export const PUMP_EVOLUTION_ENABLED_ENV = 'PUMP_EVOLUTION_ENABLED' as const;

/** Default timeout (ms) for flushing pending spans on shutdown. */
export const DEFAULT_FLUSH_TIMEOUT_MS = 5_000 as const;
