# Lições Aprendidas — Integração pump-evolution

## 1. O CTA aceita APENAS spans com `gen_ai.operation.name = "chat"`

- Span name `invoke_model` → `accepted: 0` (descartado)
- Span name `execute_tool` → `accepted: 0` (descartado)
- Span name `chat` + atributo `gen_ai.operation.name = "chat"` → `accepted: 1`

O `instrument_bedrock()` do SDK já emite no formato correto. Pra providers
manuais, SEMPRE setar `gen_ai.operation.name = "chat"`.

## 2. Duas identidades — e o login do usuário passa a viver na plataforma

> **Mudou em relação ao primeiro onboarding.** Antes a regra era "não mexa no
> Cognito do agente". Ela não sobreviveu ao contato com a realidade: os claims de
> custo (`custom:department`, `custom:cost_center`) dependiam de como cada cliente
> tinha configurado o Cognito dele — e quase nunca vinham. O span saía com o
> usuário certo e **sem departamento**, ou seja, sem a atribuição de custo, que é
> a razão de tudo isto existir.

O **login dos usuários do agente passa a usar um User Pool Cognito provisionado na
conta de tooling da plataforma** — um App Client por agente, criado no *install*
via Factory API (não no registro). É esse pool que carrega os claims de custo
governados. O agente **troca o login dele para esse pool**, mesmo que já tivesse
Cognito próprio: se não tinha, cria; se tinha, cria na tooling e usa o novo.

Separado disso, o **envio de telemetria** continua usando um service account M2M
(`client_credentials`) — outra credencial, também da plataforma. As duas coisas
não se misturam:

```
Cognito de usuário (tooling)   → autentica o USUÁRIO (authorization_code + PKCE),
                                  carrega custom:department / custom:cost_center
Service account M2M (plataforma) → autentica a MÁQUINA que ENVIA telemetria
```

O wiring do login é uma chamada só, com o módulo pronto do SDK:

```python
# Python (FastAPI/Starlette)
from pump_evolution.integrations.cognito import CognitoLogin
from pump_evolution.integrations.fastapi import PumpIdentityMiddleware

login = CognitoLogin.from_env()            # lê COGNITO_* do provisionamento
login.install(app)                         # monta /auth/login, /auth/callback, /auth/logout
app.add_middleware(
    PumpIdentityMiddleware,
    user_resolver=login.user_resolver,
    id_token_resolver=login.id_token_resolver,
)
```

```ts
// Node (Express + express-session)
import { CognitoLogin } from '@topaz-ia/pump-evolution';
const login = CognitoLogin.fromEnv();
const routes = login.expressRoutes();
app.get('/auth/login', routes.login);
app.get('/auth/callback', routes.callback);
app.get('/auth/logout', routes.logout);
// por requisição: pump.withUser(login.userContextFromIdToken(req.session.pumpIdToken), () => handler())
```

## 3. Department vem do id_token do pool da tooling, não do grupo interno

O `group_name` do app (ex: "Administrador") é o grupo de ACESSO interno — **não** é
o departamento. O departamento real vem do `custom:department` no id_token emitido
pelo **pool da tooling**, que a plataforma governa. O middleware lê o id_token
guardado na sessão, decodifica (sem validar assinatura — já foi validado no login)
e extrai os claims.

Claims suportados:
- `custom:department` ou `custom:topaz_directorate` → `cta.department`
- `custom:cost_center` ou `custom:cta_cost_center` → `cta.cost_center`

## 4. HTTP 202 com `accepted: 0` = span descartado silenciosamente

O receiver aceita o request (auth OK, payload válido) mas descarta o span
se não reconhece o formato. Usar o logger do SDK pra diagnosticar:

```python
pump = PumpEvolution.init(PumpConfig(..., logger=MyLogger()))
```

## 5. O `modelId` no manifest é estático — invocações reais são dinâmicas

O campo `modelId` no manifest é obrigatório pra `kind: agent` (resource attribute
fixo). Mas o modelo REAL de cada chamada é reportado individualmente no span
via `gen_ai.request.model` (lido do `modelId` do Converse/invoke).

Agentes multi-modelo: coloque o modelo mais usado no manifest.

## 6. O SDK é NO-OP sem `PUMP_EVOLUTION_ENABLED=true`

Se a variável não está setada ou é diferente de "true", o SDK retorna um
`_NoopHandle` que não faz nada — zero overhead, zero risco.

## 7. `.env.pump` NUNCA no git

O `.gitignore` do projeto deve ter:
```
.env
.env.*
!.env.*.template
```

O secret vive no Secrets Manager ou é entregue via canal seguro.

## 8. Deploy reproduzível requer vendor no git

O SDK não está no PyPI — é distribuído como vendor. Pra deploy ser
reproduzível sem intervenção manual:
- Vendor no repo (`backend/vendor/pump_evolution/`)
- Referência no requirements: `./vendor/`
- Dockerfile copia vendor antes do `pip install`

## 9. EC2 em subnet privada pode não alcançar o endpoint

Se a EC2 não tem rota pra internet ou pro CloudFront do CTA,
o export falha silenciosamente. Verificar conectividade:
```bash
curl -X POST <otelEndpoint — pegue na aba SDK & Telemetria do componente> \
  -H "Content-Type: application/json" -d '{}'
# Deve retornar 401 (auth missing) — significa que alcançou
```

## 10. WAF bloqueia requests sem User-Agent

Testes manuais com scripts Python/Node puro podem ser bloqueados pelo WAF
(regra `NoUserAgent_HEADER`). O SDK real já manda User-Agent — é só
pegadinha em scripts ad-hoc de teste.
