# pump-evolution

SDK de telemetria para agentes de IA e servidores MCP (TypeScript/Node). Por
invocação, emite um span com identidade do usuário, tools e status de
compliance/segurança (OWASP). Agentes emitem também tokens, modelo e latência; o
**custo (USD) é derivado no CTA** (tokens × modelo) — o SDK não calcula custo. **MCP
não tem modelo**: a unidade é a chamada de tool (sem tokens/custo).

- Não altera a resposta do Bedrock/MCP — só observa.
- Nunca derruba o processo: falha de telemetria degrada em silêncio.
- Dependências: OpenTelemetry + (opcional) o SDK Bedrock que a aplicação já usa.

## Instalação

```bash
npm install @topaz-ia/pump-evolution
# agentes Bedrock também precisam do peer:
npm install @aws-sdk/client-bedrock-runtime
```

## Configuração

`manifest.yaml` (entregue no onboarding do CTA). `kind: agent` (padrão) exige
`model`; `kind: mcp` não:

```yaml
name: meu-agente
kind: agent # ou: mcp
model: anthropic.claude-3-5-haiku-20241022-v1:0 # não exigido para kind: mcp
riskTier: T2-medium
dataClassification: internal
allowedTools: [] # tools que o agente/MCP pode usar
runtime:
  telemetry:
    otelEndpoint: https://<cta>/api/telemetry/v1/traces
    serviceAccountId: svc-meu-agente # client_id do service account
```

Variáveis de ambiente (nunca no código/manifesto):

| Variável                             | Descrição                                      |
| ------------------------------------ | ---------------------------------------------- |
| `PUMP_EVOLUTION_ENABLED`             | `true` liga a telemetria (padrão: no-op total) |
| `PUMP_SERVICE_ACCOUNT_CLIENT_SECRET` | secret do service account (client-credentials) |
| `PUMP_SERVICE_ACCOUNT_TOKEN_URL`     | endpoint OAuth do Cognito (`.../oauth2/token`) |

O `client_id` vem de `runtime.telemetry.serviceAccountId` (ou passe explícito).

> Duas identidades distintas:
>
> - **Service account** (`PUMP_SERVICE_ACCOUNT_*`): identidade da MÁQUINA do
>   agente/MCP, usada só para autenticar o envio da telemetria. É **um por
>   agente/MCP (por projeto)** — não use uma genérica para todos (perde atribuição,
>   rotação e revogação isoladas). Não é por usuário humano.
> - **Identidade do usuário** (quem chamou): vem do JWT do caller via
>   `runWithIdentity` e preenche `enduser.id`/`cta.department` nos spans. É automática.

## Agente (Bedrock)

```ts
import { PumpEvolution, ConsumerTokenVerifier } from '@topaz-ia/pump-evolution';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const pump = PumpEvolution.init({
  manifest: './manifest.yaml',
  serviceAccount: {
    clientSecret: process.env.PUMP_SERVICE_ACCOUNT_CLIENT_SECRET!,
    tokenUrl: process.env.PUMP_SERVICE_ACCOUNT_TOKEN_URL!,
  },
});
const bedrock = pump.instrumentBedrock(new BedrockRuntimeClient({ region: 'us-east-1' }));
const auth = new ConsumerTokenVerifier({ issuer: process.env.CTA_AUTH_ISSUER! });

// Por request: valida o JWT do caller, extrai a identidade e roda a invocação
// já dentro do contexto de identidade (ver "Identidade").
const r = await auth.runWithIdentity(req.headers.authorization, () =>
  bedrock.send(new ConverseCommand({ modelId, messages })),
);
if (!r.ok) return res.status(401).json({ error: 'Unauthorized', reason: r.reason });

// No shutdown do processo:
await pump.shutdown();
```

## MCP

Um MCP não tem modelo — a unidade observável é a chamada de tool. Use `kind: mcp` no
manifesto e auto-instrumente o servidor antes de registrar as tools:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = pump.instrumentMcpServer(new McpServer({ name: 'meu-mcp', version: '1.0.0' }));
server.registerTool('buscar_licitacao', { inputSchema }, async (args) => run(args));
// cada tool registrada emite um span execute_tool governado

// no handler HTTP do MCP:
const r = await auth.runWithIdentity(req.headers.authorization, () =>
  transport.handleRequest(req, res, body),
);
if (!r.ok) sendUnauthorized(res, r.reason);
```

Para tools avulsas (fora do registro), use `pump.traceMcpTool({ name, input }, fn)`.
Uma tool fora do `allowedTools` gera finding de compliance (`TOOL_NOT_ALLOWED`); um
input com segredo/PII gera finding de segurança. Observa, não bloqueia.

## Identidade

`ConsumerTokenVerifier.runWithIdentity(authorizationHeader, fn)` é a forma padrão
(agente e MCP): valida o Bearer do Cognito (JWKS RS256 + issuer/audience/expiração,
fail-closed), extrai a identidade dos claims e roda `fn` dentro do contexto — os
spans saem com `enduser.id`/`cta.department` sem passar `user-id` na mão. Retorna
`{ ok, user }` (você sabe quem é o usuário) e propaga o JWT em `user.token`.

Primitiva de baixo nível: `pump.withUser({ userId, department }, fn)` — quando a
identidade não vem de um JWT. Sem identidade, o span recebe `cta.identity.anonymous=true`
(nunca inventa usuário).

## Comportamento

- Sem `PUMP_EVOLUTION_ENABLED=true`, o SDK é no-op total (zero overhead).
- Falha de export degrada em silêncio (retry + circuit breaker por target); nunca lança.
- Privacidade: findings registram só o rótulo da regra e a localização — nunca o valor.

## Requisitos

- Node.js 20+
- `@aws-sdk/client-bedrock-runtime` (peer, apenas para agentes Bedrock)
