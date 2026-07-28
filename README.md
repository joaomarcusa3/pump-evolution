# pump-evolution

SDK de telemetria **plug-and-play** para agentes de IA (TypeScript/Node).

Você embrulha seu cliente Amazon Bedrock com o pump e, a cada invocação, ele emite
automaticamente um span com **identidade do usuário, tokens, custo, latência, ferramentas
usadas e status de compliance/segurança (OWASP)** para o **Control Tower AI**.

- **Não** muda a resposta do Bedrock — só observa.
- **Nunca** derruba seu agente: se a telemetria falhar, ela degrada em silêncio.
- Zero dependências internas. Só OpenTelemetry + o SDK Bedrock que você já usa.

---

## O que você precisa fazer (4 passos)

### 1. Instalar

```bash
npm install @a3data/pump-evolution @aws-sdk/client-bedrock-runtime
```

### 2. Criar o `manifest.yaml` do seu agente

O time do Control Tower te entrega esses valores no onboarding do agente.

```yaml
name: meu-agente
model: anthropic.claude-3-5-haiku-20241022-v1:0
riskTier: T2-medium
dataClassification: internal
allowedTools: [] # liste as tools que o agente pode usar
runtime:
  telemetry:
    otelEndpoint: https://<seu-cta>/v1/traces # OTLP do CTA
    serviceAccountId: svc-meu-agente # client_id do service account
```

### 3. Definir as variáveis de ambiente (nunca no código)

```bash
export PUMP_EVOLUTION_ENABLED=true                              # liga a telemetria (padrão: desligada)
export PUMP_SERVICE_ACCOUNT_CLIENT_SECRET=<client-secret>      # secret do service account
export PUMP_SERVICE_ACCOUNT_TOKEN_URL=https://<seu-cognito>/oauth2/token
```

### 4. Embrulhar o cliente Bedrock e propagar o usuário

```ts
import { PumpEvolution } from '@a3data/pump-evolution';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Inicializa uma vez, no boot do agente.
const pump = PumpEvolution.init({
  manifest: './manifest.yaml',
  serviceAccount: {
    clientSecret: process.env.PUMP_SERVICE_ACCOUNT_CLIENT_SECRET!,
    tokenUrl: process.env.PUMP_SERVICE_ACCOUNT_TOKEN_URL!,
  },
});

// Use este cliente no lugar do seu BedrockRuntimeClient normal.
const bedrock = pump.instrumentBedrock(new BedrockRuntimeClient({ region: 'us-east-1' }));

// Em cada request, embrulhe a chamada com a identidade de quem está usando o agente.
await pump.withUser({ userId: 'alice@acme.com', department: 'engineering' }, () =>
  bedrock.send(new ConverseCommand({ modelId, messages })),
);

// No shutdown do processo, dê flush nos spans pendentes.
await pump.shutdown();
```

Pronto. Toda invocação Bedrock passa a ser observada pelo Control Tower AI.

---

## Notas

- **Ligado/desligado por ambiente:** sem `PUMP_EVOLUTION_ENABLED=true`, o SDK é no-op total
  (zero overhead). Não precisa mexer no código para desligar.
- **Sem identidade?** O span é marcado como `cta.identity.anonymous=true` — nunca inventa um usuário.
- **Tools não-Bedrock:** embrulhe com `pump.traceTool('nome_da_tool', () => ...)` para observá-las.
- **Privacidade:** findings de segurança/compliance registram só o rótulo da regra e a localização —
  **nunca** o valor sensível em si (segredo/PII são redigidos).

## Requisitos

- Node.js 20+
- `@aws-sdk/client-bedrock-runtime` (peer dependency — o mesmo que seu agente já usa)
