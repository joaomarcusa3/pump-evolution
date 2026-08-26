# AGENTS.md — `@topaz-ia/pump-evolution`

Guia para agentes de IA (e humanos) que **modificam** este pacote. É uma
biblioteca instalável por terceiros — trate-a como produto público.

## O que é

SDK de telemetria (TypeScript/Node) para **agentes de IA e servidores MCP**. Por
invocação, emite um span OpenTelemetry GenAI com identidade, tokens, tools,
compliance e segurança (OWASP) para o Control Tower AI. Zero dependências `cta-*`.

## Mapa do código (`src/`)

| Arquivo                                                                   | Responsabilidade                                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `pump-evolution.ts`                                                       | Composição pública `PumpEvolution.init` → `PumpHandle`         |
| `bedrock-instrumentation.ts`                                              | Instrumenta o cliente Bedrock (Converse/InvokeModel)           |
| `mcp-instrumentation.ts`                                                  | `traceMcpTool` / `instrumentMcpServer` (MCP)                   |
| `consumer-auth.ts`                                                        | `ConsumerTokenVerifier` (JWKS RS256) + `runWithIdentity`       |
| `identity-context.ts`                                                     | `withUser` (ALS), `claimsToUserContext`, `applyIdentityToSpan` |
| `compliance-checker.ts`                                                   | Regras de compliance (allowlist, guardrail-gap)                |
| `security-checker.ts`                                                     | OWASP LLM runtime (injeção, segredo/PII, consumo)              |
| `tracer.ts` / `otlp-exporter.ts` / `token-provider.ts` / `resilience.ts`  | Plumbing (`@internal`)                                         |
| `manifest-loader.ts` / `config-resolver.ts` / `constants.ts` / `types.ts` | Contratos e config                                             |
| `index.ts`                                                                | **Barrel** — a superfície pública                              |

## Invariantes (não quebrar)

1. **Telemetria nunca derruba o processo.** Todo caminho de observação/export é
   guardado e degrada em silêncio. Nada lança para o fluxo do agente/MCP.
   Isso vale para o caminho de RUNTIME (span, export, checkers). **Setup é
   diferente**: `init` valida manifesto/config de cara, e `instrumentMcpServer`
   lança quando o servidor não expõe superfície de tool conhecida — degradar ali
   significa zero span com o processo se dizendo instrumentado, o pior dos
   mundos. Falhar no boot é barulhento por escolha.
2. **Zero fallback silencioso.** Config/identidade ausente é explícita. Auth é
   fail-closed (`Result` `{ ok:false, reason }`), nunca `throw` para o chamador.
3. **Privacidade.** Findings registram só o rótulo da regra + localização — nunca
   o valor sensível (segredo/PII redigidos).
4. **Sem `console.*`** no `src/` — use o `TelemetryLogger` injetável.
5. **Sem deps internas `cta-*`.** Só OpenTelemetry (+ Bedrock como peer opcional).
6. **`no-op` quando desabilitado** (`PUMP_EVOLUTION_ENABLED != 'true'`): zero overhead.

## API pública

A superfície é `src/index.ts`. Marque plumbing de baixo nível com `@internal`.
Ao mudar a API pública, atualize o relatório: `pnpm api:extract` e commite
`etc/pump-evolution.api.md`. O CI roda `api:check` e falha se divergir.

## Testes (obrigatório)

- `vitest`, AAA, comportamento observável. Spans via `InMemorySpanExporter`.
- SDK AWS via `aws-sdk-client-mock`; auth via par RSA em memória + JWKS mockado.
- Cubra fail-closed e bordas. Falha de teste é sinal — nunca mascare.
- **Instrumentação de terceiro se testa contra o SDK de verdade**, não contra um
  duplo: `tests/mcp-instrumentation.real-sdk.test.ts` liga cliente e servidor MCP
  reais por transport in-memory. Um fake só confirma o formato que você imaginou —
  foi assim que `instrumentMcpServer` passou meses sem instrumentar a classe
  `Server`, com a suíte verde.

## Fluxo

`pnpm build` (tsup, ESM+CJS+dts) · `pnpm typecheck` · `pnpm lint` · `pnpm test`.
Release via Changesets (`pnpm changeset`). Não edite versão/CHANGELOG à mão.

## Proibições

- Introduzir dependência `cta-*` ou tornar a auth acoplada a `PUMP_EVOLUTION_ENABLED`.
- Emitir métrica fabricada (ex.: `0` quando o dado é ausente — use o marcador
  `cta.usage.tokens_available=false`).
- Alterar contrato público sem atualizar o `.api.md` e um changeset.
