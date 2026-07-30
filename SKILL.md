---
name: telemetria-governada-pump-evolution
description: Instrumentar um agente de IA (Bedrock) ou servidor MCP com telemetria governada — identidade do usuário, tokens, tools, compliance e segurança OWASP — enviada ao Control Tower AI via @topaz-ia/pump-evolution. Use ao onboardar um agente/MCP externo que precisa aparecer na observabilidade e na governança de custo do CTA.
---

# Skill: telemetria governada com `@topaz-ia/pump-evolution`

Adiciona observabilidade governada a um agente ou MCP **sem alterar a resposta** e
**sem risco de derrubar o processo** (falha de telemetria degrada em silêncio).

## Quando usar

- Onboardar um agente/MCP que roda fora do CTA e precisa reportar uso.
- Você precisa saber **quem** usou (via SSO/Cognito), quais **tools**, e o status de
  **compliance/segurança** — e, para agentes, **tokens** (o custo é derivado no CTA).

## Pré-requisitos (entregues no onboarding do CTA)

- `manifest.yaml` (com `serviceAccountId` e `otelEndpoint`).
- Service account **por projeto** (client_id + secret, grant client-credentials).
- Issuer do Cognito para validar o JWT de quem chama.

## Passos

1. Instalar: `npm install @topaz-ia/pump-evolution` (+ `@aws-sdk/client-bedrock-runtime` para agentes).
2. Inicializar uma vez no boot:
   ```ts
   import { PumpEvolution, ConsumerTokenVerifier } from '@topaz-ia/pump-evolution';
   const pump = PumpEvolution.init({
     manifest: './manifest.yaml',
     serviceAccount: {
       clientSecret: process.env.PUMP_SERVICE_ACCOUNT_CLIENT_SECRET!,
       tokenUrl: process.env.PUMP_SERVICE_ACCOUNT_TOKEN_URL!,
     },
   });
   const auth = new ConsumerTokenVerifier({ issuer: process.env.CTA_AUTH_ISSUER! });
   ```
3. **Agente:** `const bedrock = pump.instrumentBedrock(client)`.
   **MCP:** `const server = pump.instrumentMcpServer(mcpServer)` (antes de registrar tools).
4. Por request, autenticar + propagar identidade numa chamada:
   ```ts
   const r = await auth.runWithIdentity(req.headers.authorization, () => /* invoca */);
   if (!r.ok) return unauthorized(r.reason); // fail-closed
   ```
5. No shutdown: `await pump.shutdown()`.

## Identidade automática (SSO/Cognito)

`runWithIdentity` valida o Bearer do Cognito e preenche `enduser.id`/`cta.department`
nos spans — sem passar `user-id` na mão. `r.user` diz quem é o usuário.

## Regras

- Ligue com `PUMP_EVOLUTION_ENABLED=true` (senão é no-op total).
- **Um service account por projeto** — nunca uma credencial genérica compartilhada.
- Segredo **sempre** em env/Secrets Manager, nunca no manifesto/imagem.
- MCP não tem modelo → sem tokens/custo (a unidade é a chamada de tool).

Referência completa: `README.md`. Para contribuir: `CONTRIBUTING.md` / `AGENTS.md`.
