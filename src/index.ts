/**
 * `@topaz-ia/pump-evolution` — public API surface.
 *
 * This barrel is the single entry point external agent developers import from.
 * Task 1 establishes the shared contracts and semantic-convention constants;
 * later tasks add the runtime components (ManifestLoader, BedrockInstrumentation,
 * IdentityContext, ToolTracer, ComplianceChecker, OtlpExporter, and the
 * `PumpEvolution.init` composition).
 */

export * from './constants.js';
export { resolveTelemetryConfig } from './config-resolver.js';
export type { ResolvedServiceAccount, ResolvedTelemetryConfig } from './config-resolver.js';
export {
  loadManifest,
  loadResourceAttributes,
  manifestToResourceAttributes,
} from './manifest-loader.js';
export {
  buildResource,
  createTracerProvider,
  getTracer,
  resolveSampler,
  TRACER_NAME,
  TRACER_VERSION,
} from './tracer.js';
export type { CreateTracerProviderOptions } from './tracer.js';
export {
  applyIdentityToSpan,
  claimsToUserContext,
  getCurrentUser,
  parseIdentityHeaders,
  withUser,
} from './identity-context.js';
export type { IdentityHeaderInput } from './identity-context.js';
export { instrumentBedrockClient } from './bedrock-instrumentation.js';
export type {
  BedrockInstrumentationDeps,
  ComplianceConfig,
  SecurityConfig,
} from './bedrock-instrumentation.js';
export { traceMcpTool, instrumentMcpServer } from './mcp-instrumentation.js';
export type { McpToolTracerDeps } from './mcp-instrumentation.js';
export { ConsumerTokenVerifier } from './consumer-auth.js';
export type { ConsumerAuthConfig, ConsumerAuthResult, JwksFetchLike } from './consumer-auth.js';
export { CognitoLogin } from './cognito-login.js';
export type { CallbackResult, CognitoFetchLike, CognitoLoginConfig, Pkce } from './cognito-login.js';
export { init, PumpEvolution } from './pump-evolution.js';
export type { PumpInitInternals } from './pump-evolution.js';
export {
  extractToolUseFromStreamEvent,
  extractToolUses,
  recordToolUseSpans,
  traceTool,
} from './tool-tracer.js';
export type { ObservedToolUse } from './tool-tracer.js';
export {
  applyComplianceToSpan,
  checkDataClassificationGuardrail,
  checkTools,
  evaluateCompliance,
  FINDING_GUARDRAIL_EVIDENCE_MISSING,
  FINDING_TOOL_NOT_ALLOWED,
  summarizeCompliance,
} from './compliance-checker.js';
export type { ComplianceEvaluationInput } from './compliance-checker.js';
export {
  applySecurityToSpan,
  detectPromptInjection,
  detectSensitiveInfo,
  detectUnboundedConsumption,
  evaluateSecurity,
  FINDING_PROMPT_INJECTION,
  FINDING_SENSITIVE_INFO_DISCLOSURE,
  FINDING_UNBOUNDED_CONSUMPTION,
  summarizeSecurity,
} from './security-checker.js';
export type { SecurityEvaluationInput } from './security-checker.js';
export { ServiceAccountTokenProvider, DEFAULT_TELEMETRY_SCOPE } from './token-provider.js';
export type { FetchLike, ServiceAccountTokenProviderDeps } from './token-provider.js';
export { backoffDelayMs, CircuitBreaker, withRetry } from './resilience.js';
export type { CircuitBreakerOptions, CircuitState, RetryOptions } from './resilience.js';
export { createOtlpBatchProcessor, ResilientAuthSpanExporter } from './otlp-exporter.js';
export type {
  DelegateFactory,
  OtlpBatchProcessorOptions,
  ResilientAuthSpanExporterDeps,
  TelemetryLogger,
} from './otlp-exporter.js';
export type {
  AgentManifest,
  ComplianceFinding,
  ComplianceSeverity,
  ComplianceStatus,
  ComplianceSummary,
  DataClassification,
  ItemKind,
  ManifestOwner,
  ManifestRuntime,
  ManifestTelemetry,
  McpToolInvocation,
  PumpConfig,
  PumpHandle,
  ResourceAttributes,
  RiskTier,
  OwaspLlmCategory,
  SecurityFinding,
  SecurityFindingLocation,
  SecuritySeverity,
  SecurityStatus,
  SecuritySummary,
  ServiceAccountCredentials,
  UsageEventContract,
  UserContext,
} from './types.js';
