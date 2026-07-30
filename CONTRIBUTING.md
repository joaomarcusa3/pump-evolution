# Contributing to `@topaz-ia/pump-evolution`

Telemetry SDK for AI agents and MCP servers. This document covers local
development, standards, and the release process.

## Setup

Requires Node.js 20.11+ and pnpm 9+. From the monorepo root:

```bash
pnpm install
pnpm --filter @topaz-ia/pump-evolution build
```

## Scripts

| Script                                             | O que faz                                        |
| -------------------------------------------------- | ------------------------------------------------ |
| `pnpm --filter @topaz-ia/pump-evolution build`       | Bundle ESM+CJS + `.d.ts`/`.d.cts` (tsup)         |
| `pnpm --filter @topaz-ia/pump-evolution test`        | Testes (vitest)                                  |
| `pnpm --filter @topaz-ia/pump-evolution typecheck`   | `tsc --noEmit` (strict)                          |
| `pnpm --filter @topaz-ia/pump-evolution lint`        | ESLint                                           |
| `pnpm --filter @topaz-ia/pump-evolution docs`        | Gera a documentação de API (typedoc → `docs/`)   |
| `pnpm --filter @topaz-ia/pump-evolution api:extract` | Atualiza o relatório de API (`etc/*.api.md`)     |
| `pnpm --filter @topaz-ia/pump-evolution api:check`   | Verifica que a API pública não mudou sem revisão |

## Padrões de código

- **TypeScript strict**, sem `any`. Sem `as unknown as` sem justificativa.
- **Zero fallback silencioso**: ausência de config/identidade é explícita, não um
  default mascarado. Erros de auth retornam `Result` (`{ ok:false, reason }`),
  não `throw` para o fluxo do chamador.
- **Telemetria nunca derruba o processo**: todo caminho de export/observação é
  guardado e degrada em silêncio (o `BatchSpanProcessor` roda fora do hot path).
- **Sem `console.*`** no `src/` — use o `TelemetryLogger` injetável.
- **Privacidade**: findings de segurança/compliance registram só o rótulo da regra
  e a localização — nunca o valor sensível.
- **Zero dependências internas `cta-*`**: o SDK é instalável por terceiros; só
  depende de OpenTelemetry (e do SDK Bedrock como peer opcional).

## Testes

- `vitest`, padrão AAA. Teste comportamento observável, não implementação.
- Spans: use `InMemorySpanExporter` + `SimpleSpanProcessor` (nunca rede real).
- SDK AWS: `aws-sdk-client-mock`. Auth: par de chaves RSA em memória + JWKS mockado.
- Cubra caminhos de erro/borda (fail-closed, token inválido, kid desconhecido…).

## API pública e estabilidade

A superfície pública é o barrel `src/index.ts`. Exports marcados `@internal` são
plumbing de baixo nível e podem mudar sem aviso. Ao alterar a API pública:

```bash
pnpm --filter @topaz-ia/pump-evolution api:extract   # atualiza etc/pump-evolution.api.md
```

Commite o `.api.md` junto. O CI roda `api:check` e falha se o relatório divergir —
isso força revisão consciente de qualquer mudança de contrato público.

## Release

Versionamento via [Changesets](https://github.com/changesets/changesets). Toda
mudança que afeta consumidores precisa de um changeset:

```bash
pnpm changeset               # descreva a mudança (patch/minor/major)
```

O bump de versão e o `CHANGELOG.md` são gerados no fluxo de release
(`pnpm changeset version`), não manualmente.
