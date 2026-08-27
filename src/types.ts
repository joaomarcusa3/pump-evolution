/**
 * Shared contract types for the `@topaz-ia/pump-evolution` SDK.
 *
 * These types are intentionally standalone: the SDK is installed by external
 * agent developers and MUST NOT depend on any internal `cta-*` package. Where a
 * type mirrors a CTA concept (e.g. the agent manifest or the server-side usage
 * event) it is redefined here as a faithful, minimal subset rather than imported.
 */

// ─── Manifest (subset of the real AgentSpecProps) ────────────────────────────

/**
 * Data classification levels the SDK understands. Mirrors the CTA
 * `DataClassificationValue` union (`restricted` is deliberately excluded —
 * GenAI does not process restricted data).
 */
export type DataClassification = 'public' | 'internal' | 'sensitive';

/**
 * Risk tiers the SDK understands. Mirrors the CTA `RiskTier` value strings.
 */
export type RiskTier = 'T1-low' | 'T2-medium' | 'T3-sensitive' | 'T4-autonomous';

/**
 * Kind of item the manifest describes:
 *  - `agent` — an LLM-backed agent (has a `modelId`). Default when omitted.
 *  - `mcp`   — a Model Context Protocol server: a governed tool provider with no
 *              model of its own. `modelId` is not required for this kind.
 *
 * The CTA quer mapear MCPs no mesmo pipeline de observabilidade que os agentes,
 * então o SDK trata os dois — a unidade observável de um MCP são as chamadas de
 * tool (`traceMcpTool`), não invocações de modelo.
 */
export type ItemKind = 'agent' | 'mcp';

/**
 * Owner block of the manifest. `email` is the auditable principal; `team` and
 * `costCenter` enable FinOps chargeback.
 */
export interface ManifestOwner {
  readonly email: string;
  readonly team?: string;
  readonly costCenter?: string;
}

/**
 * Telemetry configuration declared in the manifest (ADR-0040,
 * `ExternalRuntimeTelemetry`). When present, these values act as defaults for
 * the SDK's runtime configuration.
 */
export interface ManifestTelemetry {
  /** OTLP endpoint the agent pushes spans to. */
  readonly otelEndpoint: string;
  /** `client_id` of the Cognito service account issued for this agent. */
  readonly serviceAccountId: string;
}

/**
 * External runtime block (subset of the real `ExternalRuntime`). Only the parts
 * the SDK needs to resolve telemetry defaults are modelled here.
 */
export interface ManifestRuntime {
  readonly external?: boolean;
  readonly telemetry?: ManifestTelemetry;
}

/**
 * Faithful subset of the real `AgentSpecProps` (see
 * `packages/cta-agent-lifecycle/src/domain/value-objects/agent-spec.ts`).
 * Only the fields the SDK reads from `manifest.yaml` to build resource
 * attributes are included. Optional fields stay optional — the SDK never fills
 * them with placeholders.
 */
export interface AgentManifest {
  /** Unique short identifier of the agent within the tenant. */
  readonly name: string;
  /**
   * Item kind. `agent` (default when omitted) or `mcp`. Governs whether
   * `modelId` is required (agents) or not (MCP servers).
   */
  readonly kind?: ItemKind;
  /**
   * Model identifier (e.g. `anthropic.claude-sonnet-4`). REQUIRED for
   * `kind: agent`; not applicable to `kind: mcp` (an MCP server has no model).
   */
  readonly modelId?: string;
  /** Allowlist of tool names the agent may use. */
  readonly allowedTools: readonly string[];
  /** Risk tier. */
  readonly riskTier?: RiskTier;
  /** Formal owner (email + team + costCenter). */
  readonly owner?: ManifestOwner;
  /** Cost center for chargeback/showback. */
  readonly costCenter?: string;
  /** Squad/team responsible for the agent (kebab-case). */
  readonly squad?: string;
  /** Data classification level. */
  readonly dataClassification?: DataClassification;
  /** External runtime block — source of telemetry defaults (ADR-0040). */
  readonly runtime?: ManifestRuntime;
}

// ─── SDK init configuration ──────────────────────────────────────────────────

/**
 * Service account credentials (OAuth client-credentials) used to authenticate
 * OTLP export to the CTA telemetry receiver.
 *
 * `clientId` is optional: when omitted, it defaults to the manifest's
 * `runtime.telemetry.serviceAccountId` (ADR-0040 — that field is documented as
 * the Cognito service account `client_id`). `clientSecret` and `tokenUrl` are
 * required and always come from the developer's environment/config — secrets
 * are never stored in the manifest.
 */
export interface ServiceAccountCredentials {
  /** Cognito app `client_id`. Optional — defaults from manifest `serviceAccountId`. */
  readonly clientId?: string;
  /** Client secret. Required — never in the manifest. */
  readonly clientSecret: string;
  /** OAuth token endpoint. Required — never in the manifest. */
  readonly tokenUrl: string;
}

/**
 * Initialization configuration for `PumpEvolution.init`.
 */
/**
 * Minimal, injectable diagnostic logger. By default the SDK degrades **silently**
 * (the steering forbids `console.*`), which means export failures — an invalid
 * or expired service-account credential (401), a missing scope (403), a network
 * error or a 5xx — are lost with no trace. Provide a `logger` in {@link PumpConfig}
 * to surface those instead of losing them.
 *
 * PRIVACY: the SDK only ever passes rule labels, endpoints, HTTP status and short
 * error messages here — never secrets, tokens, prompts or PII.
 */
export interface TelemetryLogger {
  warn?(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

export interface PumpConfig {
  /**
   * OTLP/HTTP endpoint of the CTA telemetry receiver. Optional — when omitted it
   * defaults to the manifest's `runtime.telemetry.otelEndpoint` (ADR-0040).
   */
  readonly endpoint?: string;
  /** Service account credentials for authenticated export. */
  readonly serviceAccount: ServiceAccountCredentials;
  /** Manifest path (`manifest.yaml`) or an already-parsed manifest object. */
  readonly manifest: string | AgentManifest;
  /** Master switch. When `false` (or `PUMP_EVOLUTION_ENABLED` is not `true`) the SDK is a no-op. */
  readonly enabled?: boolean;
  /** Timeout (ms) for flushing pending spans on shutdown. */
  readonly flushTimeoutMs?: number;
  /** Trace sampling ratio in the range `[0, 1]`. */
  readonly sampling?: number;
  /**
   * OWASP LLM runtime security scanning (Fatia 1b). Default: ON when the SDK is
   * enabled. The agent's input/output text is scanned LOCALLY for OWASP LLM
   * signals and only REDACTED findings are emitted (`cta.security.*`) — the raw
   * content is never sent as telemetry. Set `{ enabled: false }` to opt out.
   */
  readonly security?: {
    readonly enabled?: boolean;
    /** Optional per-invocation token ceiling for the LLM10 (unbounded consumption) check. */
    readonly maxTotalTokens?: number;
  };
  /**
   * Optional diagnostic logger (see {@link TelemetryLogger}). When provided, the
   * SDK reports export failures (auth 401/403, network, 5xx) instead of degrading
   * silently — the single most useful signal when telemetry "isn't arriving".
   * Omitted → truly silent (unchanged default). Never receives sensitive values.
   */
  readonly logger?: TelemetryLogger;
}

// ─── Resource attributes produced by the SDK ─────────────────────────────────

/**
 * OpenTelemetry resource attributes the SDK derives from the manifest. Keys are
 * the literal attribute names emitted on every span. Optional fields are omitted
 * (never placeholder-filled) when the corresponding manifest field is absent.
 */
export interface ResourceAttributes {
  readonly 'service.name': string;
  readonly 'gen_ai.agent.id': string;
  /** Present for agents; omitted for `kind: mcp` (no model). */
  readonly 'gen_ai.request.model'?: string;
  /**
   * `agent` | `mcp`. Always set by {@link manifestToResourceAttributes} so the
   * receiver can dimension the source; optional in the type only so existing
   * hand-built `ResourceAttributes` literals stay valid.
   */
  readonly 'cta.item_kind'?: ItemKind;
  readonly 'cta.cost_center'?: string;
  readonly 'cta.squad'?: string;
  readonly 'cta.data_classification'?: DataClassification;
  readonly 'cta.risk_tier'?: RiskTier;
  readonly 'cta.allowed_tools'?: readonly string[];
}

// ─── Compliance ───────────────────────────────────────────────────────────────

/** Compliance status set on the invocation span. */
export type ComplianceStatus = 'compliant' | 'non_compliant';

/** Severity of a compliance finding. */
export type ComplianceSeverity = 'info' | 'warning' | 'critical';

/**
 * A single compliance finding produced by the SDK when it detects a deviation
 * from the manifest (e.g. a tool used outside `allowedTools`, or a missing
 * guardrail for a given `dataClassification`).
 *
 * This is a new type local to the SDK contract. It intentionally does not try to
 * unify with the gate-pipeline finding vocabulary in `cta-governance`/`cta-auditors`
 * (related concepts, not the same data).
 */
export interface ComplianceFinding {
  /** Machine-readable finding code (e.g. `TOOL_NOT_ALLOWED`). */
  readonly code: string;
  /** Severity of the finding. */
  readonly severity: ComplianceSeverity;
  /** Human-readable description. */
  readonly message: string;
  /** Tool the finding relates to, when applicable. */
  readonly tool?: string;
  /** Data classification the finding relates to, when applicable. */
  readonly dataClassification?: DataClassification;
}

/** Compliance summary attached to a usage event. */
export interface ComplianceSummary {
  readonly status: ComplianceStatus;
  readonly findings?: readonly ComplianceFinding[];
}

// ─── Security (OWASP LLM Top 10 — runtime signals) ─────────────────────────────

/**
 * OWASP LLM Top 10 (2025) category identifiers. The SDK observes a subset at
 * runtime (it cannot statically analyse the whole app), so only the categories
 * the SDK actually emits are documented as used; the full union is modelled for
 * forward-compatibility with server-side aggregation.
 */
export type OwaspLlmCategory =
  | 'LLM01' // Prompt Injection
  | 'LLM02' // Insecure Output Handling
  | 'LLM03' // Training Data Poisoning
  | 'LLM04' // Model Denial of Service
  | 'LLM05' // Supply Chain
  | 'LLM06' // Sensitive Information Disclosure
  | 'LLM07' // Insecure Plugin Design
  | 'LLM08' // Excessive Agency
  | 'LLM09' // Overreliance
  | 'LLM10'; // Unbounded Consumption

/** Security posture set on the invocation span. */
export type SecurityStatus = 'secure' | 'at_risk';

/** Severity of a security finding (same ladder as compliance). */
export type SecuritySeverity = ComplianceSeverity;

/** Where in the invocation a security finding was observed. */
export type SecurityFindingLocation = 'input' | 'output' | 'tool' | 'usage';

/**
 * A single runtime security finding aligned to the OWASP LLM Top 10.
 *
 * PRIVACY INVARIANT: a finding NEVER carries the raw offending value (the
 * injected prompt, the leaked secret/PII). It carries the machine-readable rule
 * label and the location only — telemetry must not itself become a data leak.
 */
export interface SecurityFinding {
  /** Machine-readable finding code (e.g. `PROMPT_INJECTION`). */
  readonly code: string;
  /** OWASP LLM Top 10 category. */
  readonly owaspCategory: OwaspLlmCategory;
  /** Severity of the finding. */
  readonly severity: SecuritySeverity;
  /** Human-readable description (no sensitive value). */
  readonly message: string;
  /** Which part of the invocation triggered the finding. */
  readonly location: SecurityFindingLocation;
  /** Redacted rule label (e.g. `aws_access_key_id`) — NEVER the raw value. */
  readonly rule?: string;
}

/** Security summary attached to a usage event / invocation span. */
export interface SecuritySummary {
  readonly status: SecurityStatus;
  readonly findings?: readonly SecurityFinding[];
}

// ─── Usage event contract (SDK side) ──────────────────────────────────────────

/**
 * SDK-side contract describing what the agent's usage data conceptually maps to
 * on the wire. This mirrors the server's internal `UsageEvent`
 * (`packages/cta-api/src/services/usage-metering.ts`) but is a standalone type —
 * there is no cross-package import. The server owns the authoritative type; this
 * is the shape the SDK's spans are designed to translate into.
 */
export interface UsageEventContract {
  /** Fixed source discriminator for SDK-emitted telemetry. */
  readonly source: 'external-otel';
  /** End-user identifier, or an explicit anonymous marker upstream. */
  readonly userId: string;
  readonly department?: string;
  readonly costCenter?: string;
  readonly model: string;
  readonly provider?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs?: number;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly metadata?: {
    /** Names of the `execute_tool` child spans. */
    readonly tools?: readonly string[];
    /** Compliance status + findings for the invocation. */
    readonly compliance?: ComplianceSummary;
    /** OWASP LLM security posture + findings for the invocation. */
    readonly security?: SecuritySummary;
  };
}

// ─── Handle returned by init ──────────────────────────────────────────────────

/**
 * User identity context propagated for a flow via `withUser`.
 */
export interface UserContext {
  readonly userId?: string;
  readonly department?: string;
  readonly costCenter?: string;
  /** Original propagated JWT (never emitted by the SDK). */
  readonly token?: string;
}

/**
 * A single MCP tool invocation to be traced as a governed `execute_tool` span.
 * `input`, when provided, is scanned LOCALLY for OWASP LLM signals and only
 * REDACTED findings are emitted — the raw input is never sent as telemetry.
 */
export interface McpToolInvocation {
  /** MCP tool name (`gen_ai.tool.name`). */
  readonly name: string;
  /** Optional serialized tool input/arguments, scanned locally (redacted). */
  readonly input?: string;
}

/**
 * Controllable handle returned by `PumpEvolution.init`. The concrete
 * implementation is provided by the `init` composition; this is the public
 * contract external developers program against.
 */
export interface PumpHandle {
  /**
   * Instruments a `BedrockRuntimeClient` in place (idempotent) so every model
   * invocation emits a GenAI span with usage, identity, tools and compliance.
   * Returns the same client. When the SDK is disabled, returns it untouched.
   *
   * Typed structurally (`C`) to avoid a hard dependency on the AWS SDK types at
   * this contract boundary — the underlying implementation expects an AWS SDK v3
   * `BedrockRuntimeClient`.
   */
  instrumentBedrock<C>(client: C): C;
  /**
   * Wraps a non-Bedrock tool call in an `execute_tool` span (framework-agnostic;
   * Requirement 5.2). When the SDK is disabled, runs `fn` untraced.
   */
  traceTool<T>(name: string, fn: () => T): T;
  /**
   * Wraps a **governed MCP tool call** in an `execute_tool` span with the SAME
   * compliance (allowedTools) + OWASP-LLM security checks agents get. Use this
   * from an MCP server's tool handler (or an MCP client's `callTool`) so the CTA
   * maps MCP servers in the same observability pipeline as agents. When the SDK
   * is disabled, runs `fn` untraced.
   */
  traceMcpTool<T>(invocation: McpToolInvocation, fn: () => T): T;
  /**
   * Auto-instruments an MCP server (`@modelcontextprotocol/sdk`) in place so
   * every tool call it serves is governed automatically — no per-handler
   * `traceMcpTool` wrapping. Returns the same server. Call it right after
   * constructing the server and BEFORE registering tools. When the SDK is
   * disabled, returns the server untouched.
   *
   * Covers BOTH server classes the MCP SDK ships: `McpServer` (high level —
   * `registerTool` / `tool` are wrapped) and `Server` (low level — the
   * `tools/call` handler registered via `setRequestHandler` is wrapped). A
   * server exposing neither surface THROWS: no span would ever be emitted, and
   * failing silently there is what this API must never do.
   *
   * Typed structurally (`S`) to avoid a hard dependency on the MCP SDK types.
   */
  instrumentMcpServer<S>(server: S): S;
  /** Run `fn` with the given user identity propagated to all spans in the flow. */
  withUser<T>(ctx: UserContext, fn: () => T): T;
  /** Flush pending spans and tear down the telemetry pipeline. */
  shutdown(): Promise<void>;
}
