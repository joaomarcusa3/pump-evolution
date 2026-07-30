/**
 * ManifestLoader — parses and validates the agent `manifest.yaml` (a faithful
 * subset of the real `AgentSpecProps`) into OpenTelemetry `ResourceAttributes`.
 *
 * Invariant: ZERO fallback (ADR-0031). A missing file, unreadable file, invalid
 * YAML, or a missing/invalid required field throws a clear, descriptive error.
 * The loader never substitutes silent defaults and never placeholder-fills an
 * absent optional field — absent optional fields are simply omitted from the
 * resulting `ResourceAttributes`.
 *
 * The field names read from the manifest are the real ones on `AgentSpecProps`
 * (`name`, `modelId`, `allowedTools`, `owner.email`, `costCenter`, `squad`,
 * `dataClassification`, `riskTier`, `runtime.*`) — not a parallel schema.
 *
 * Scope note: telemetry-endpoint default resolution (`runtime.telemetry.*`) is
 * handled by a separate task. This module validates and preserves the `runtime`
 * block when present, but does not resolve it into SDK config.
 */

import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import {
  CTA_ALLOWED_TOOLS,
  CTA_COST_CENTER,
  CTA_DATA_CLASSIFICATION,
  CTA_ITEM_KIND,
  CTA_RISK_TIER,
  CTA_SQUAD,
  GEN_AI_AGENT_ID,
  GEN_AI_REQUEST_MODEL,
  SERVICE_NAME,
} from './constants.js';
import type {
  AgentManifest,
  DataClassification,
  ItemKind,
  ManifestOwner,
  ManifestRuntime,
  ManifestTelemetry,
  ResourceAttributes,
  RiskTier,
} from './types.js';

// ─── Allowed enum values (mirror the real AgentSpec validation) ───────────────

/**
 * Data classification values the SDK accepts. Mirrors the CTA
 * `DataClassificationValue` union (`restricted` excluded — GenAI does not
 * process restricted data).
 */
const VALID_DATA_CLASSIFICATIONS: readonly DataClassification[] = [
  'public',
  'internal',
  'sensitive',
];

/** Risk tier values the SDK accepts. Mirrors the CTA `RiskTier` value strings. */
const VALID_RISK_TIERS: readonly RiskTier[] = [
  'T1-low',
  'T2-medium',
  'T3-sensitive',
  'T4-autonomous',
];

/** Item kinds the SDK accepts. `agent` (default) has a model; `mcp` does not. */
const VALID_ITEM_KINDS: readonly ItemKind[] = ['agent', 'mcp'];

/** Default kind when the manifest omits it (documented semantic default). */
const DEFAULT_ITEM_KIND: ItemKind = 'agent';

// ─── Small narrowing / description helpers ────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return String(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(origin: string, detail: string): never {
  throw new Error(`[pump-evolution] manifest (${origin}) ${detail} No default is applied.`);
}

// ─── Field validators (each throws on invalid input — fail-fast) ──────────────

function requireNonEmptyString(value: unknown, field: string, origin: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(
      origin,
      `field "${field}" is required and must be a non-empty string, got ${describeValue(value)}.`,
    );
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string, origin: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(
      origin,
      `field "${field}" must be a non-empty string when present, got ${describeValue(value)}.`,
    );
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, origin: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    fail(origin, `field "${field}" must be a boolean when present, got ${describeValue(value)}.`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string, origin: string): string[] {
  // Deve estar presente e ser um array (ausente/não-array falha). PODE ser
  // vazio: agentes só-Converse (sem tool-calling) declaram allowedTools: [].
  if (!Array.isArray(value)) {
    fail(
      origin,
      `field "${field}" is required and must be an array of tool names, got ${describeValue(
        value,
      )}.`,
    );
  }
  const tools: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      fail(
        origin,
        `field "${field}[${index}]" must be a non-empty string, got ${describeValue(item)}.`,
      );
    }
    tools.push(item);
  });
  return tools;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  origin: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const match = allowed.find((candidate) => candidate === value);
    if (match !== undefined) return match;
  }
  fail(
    origin,
    `field "${field}" must be one of [${allowed.join(', ')}] when present, got ${describeValue(
      value,
    )}.`,
  );
}

// ─── Nested-block parsers ─────────────────────────────────────────────────────

function parseOwner(value: unknown, origin: string): ManifestOwner | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    fail(origin, `field "owner" must be an object when present, got ${describeType(value)}.`);
  }
  const email = requireNonEmptyString(value.email, 'owner.email', origin);
  const team = optionalNonEmptyString(value.team, 'owner.team', origin);
  const costCenter = optionalNonEmptyString(value.costCenter, 'owner.costCenter', origin);
  return {
    email,
    ...(team !== undefined ? { team } : {}),
    ...(costCenter !== undefined ? { costCenter } : {}),
  };
}

function parseTelemetry(value: unknown, origin: string): ManifestTelemetry | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    fail(
      origin,
      `field "runtime.telemetry" must be an object when present, got ${describeType(value)}.`,
    );
  }
  const otelEndpoint = requireNonEmptyString(
    value.otelEndpoint,
    'runtime.telemetry.otelEndpoint',
    origin,
  );
  const serviceAccountId = requireNonEmptyString(
    value.serviceAccountId,
    'runtime.telemetry.serviceAccountId',
    origin,
  );
  return { otelEndpoint, serviceAccountId };
}

function parseRuntime(value: unknown, origin: string): ManifestRuntime | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    fail(origin, `field "runtime" must be an object when present, got ${describeType(value)}.`);
  }
  const external = optionalBoolean(value.external, 'runtime.external', origin);
  const telemetry = parseTelemetry(value.telemetry, origin);
  return {
    ...(external !== undefined ? { external } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
  };
}

// ─── Validation entry point ───────────────────────────────────────────────────

/**
 * Narrows an `unknown` (parsed YAML or caller-supplied object) into a validated
 * `AgentManifest`. Throws a descriptive error on any missing/invalid required
 * field or malformed optional field.
 */
function toManifest(value: unknown, origin: string): AgentManifest {
  if (!isRecord(value)) {
    fail(origin, `must be a YAML mapping/object, got ${describeType(value)}.`);
  }

  const name = requireNonEmptyString(value.name, 'name', origin);

  // `kind` governs whether modelId is required. Absent → 'agent' (documented
  // semantic default, backward-compatible with existing agent manifests).
  const kind = optionalEnum(value.kind, VALID_ITEM_KINDS, 'kind', origin) ?? DEFAULT_ITEM_KIND;

  // modelId: required for agents (they invoke a model); not applicable to MCP
  // servers (tool providers, no model). Zero fallback: an agent without modelId
  // fails fast; an MCP with a modelId keeps it (harmless), else omits it.
  const modelId =
    kind === 'mcp'
      ? optionalNonEmptyString(value.modelId, 'modelId', origin)
      : requireNonEmptyString(value.modelId, 'modelId', origin);

  const allowedTools = requireStringArray(value.allowedTools, 'allowedTools', origin);

  const riskTier = optionalEnum(value.riskTier, VALID_RISK_TIERS, 'riskTier', origin);
  const dataClassification = optionalEnum(
    value.dataClassification,
    VALID_DATA_CLASSIFICATIONS,
    'dataClassification',
    origin,
  );
  const squad = optionalNonEmptyString(value.squad, 'squad', origin);
  const costCenter = optionalNonEmptyString(value.costCenter, 'costCenter', origin);
  const owner = parseOwner(value.owner, origin);
  const runtime = parseRuntime(value.runtime, origin);

  return {
    name,
    kind,
    ...(modelId !== undefined ? { modelId } : {}),
    allowedTools,
    ...(riskTier !== undefined ? { riskTier } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(costCenter !== undefined ? { costCenter } : {}),
    ...(squad !== undefined ? { squad } : {}),
    ...(dataClassification !== undefined ? { dataClassification } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
  };
}

// ─── Manifest → ResourceAttributes mapper ─────────────────────────────────────

/** Mutable mirror of `ResourceAttributes` used while building the result. */
type MutableResourceAttributes = {
  -readonly [K in keyof ResourceAttributes]: ResourceAttributes[K];
};

/**
 * Maps a validated `AgentManifest` to OpenTelemetry `ResourceAttributes`.
 *
 * Required manifest fields (`name`, `modelId`, `allowedTools`) always produce
 * their attributes. Optional fields are omitted entirely when absent — never
 * placeholder-filled (Requirement 2.4).
 *
 * costCenter precedence: the authoritative source is the top-level `costCenter`
 * (the field the real `AgentSpecProps` validates and uses for FinOps). When it
 * is absent, `owner.costCenter` is used as an alternate declared source. This is
 * an explicit, documented precedence between two real manifest fields — not a
 * fabricated default.
 */
export function manifestToResourceAttributes(manifest: AgentManifest): ResourceAttributes {
  const kind: ItemKind = manifest.kind ?? DEFAULT_ITEM_KIND;
  const attributes: MutableResourceAttributes = {
    [SERVICE_NAME]: manifest.name,
    [GEN_AI_AGENT_ID]: manifest.name,
    [CTA_ITEM_KIND]: kind,
    [CTA_ALLOWED_TOOLS]: [...manifest.allowedTools],
  };

  // gen_ai.request.model only when the manifest declares a model (agents).
  // MCP servers have no model → the attribute is omitted, never placeholder-filled.
  if (manifest.modelId !== undefined) attributes[GEN_AI_REQUEST_MODEL] = manifest.modelId;

  const costCenter = manifest.costCenter ?? manifest.owner?.costCenter;
  if (costCenter !== undefined) attributes[CTA_COST_CENTER] = costCenter;
  if (manifest.squad !== undefined) attributes[CTA_SQUAD] = manifest.squad;
  if (manifest.dataClassification !== undefined) {
    attributes[CTA_DATA_CLASSIFICATION] = manifest.dataClassification;
  }
  if (manifest.riskTier !== undefined) attributes[CTA_RISK_TIER] = manifest.riskTier;

  return attributes;
}

// ─── Public loader API ────────────────────────────────────────────────────────

function readManifestFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `[pump-evolution] manifest file could not be read at "${path}": ${errorMessage(err)}. ` +
        'Provide a readable manifest.yaml path or an AgentManifest object. No default is applied.',
    );
  }
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new Error(
      `[pump-evolution] manifest at "${path}" is not valid YAML: ${errorMessage(err)}. ` +
        'No default is applied.',
    );
  }
}

/**
 * Loads and validates an agent manifest from either a `manifest.yaml` file path
 * or an already-parsed object. Fail-fast: throws a descriptive error when the
 * file is missing/unreadable, the YAML is malformed, or a required field is
 * missing/invalid.
 */
export function loadManifest(source: string | AgentManifest): AgentManifest {
  if (typeof source === 'string') {
    return toManifest(readManifestFile(source), `path "${source}"`);
  }
  return toManifest(source, 'object');
}

/**
 * Convenience: loads/validates a manifest and maps it straight to
 * `ResourceAttributes`. Equivalent to
 * `manifestToResourceAttributes(loadManifest(source))`.
 */
export function loadResourceAttributes(source: string | AgentManifest): ResourceAttributes {
  return manifestToResourceAttributes(loadManifest(source));
}
