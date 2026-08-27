# Instrumentar um serviço com o pump-evolution — instruções para um agente de IA

Entregue este arquivo, o zip do SDK e as credenciais a um agente (Kiro, Claude
Code, Cursor) e peça que ele instrumente o serviço. O texto abaixo é a
instrução: cole como prompt ou aponte o arquivo.

---

Você vai instrumentar este serviço com o SDK `pump-evolution`, que envia
telemetria governada para o Control Tower AI. Siga na ordem. **Não invente
nenhum valor do passo 2** — se faltar, pare e pergunte ao humano.

## 1. Descubra o terreno

Leia o código antes de perguntar. Você precisa saber:

- **Stack:** Python ou Node.js. O zip traz as duas — `python/src/` e `node/`.
- **Framework web:** FastAPI, Express, Flask, outro.
- **Onde o app guarda o usuário logado.** Em FastAPI costuma ser
  `request.state.user`; pode ser outro lugar.
- **Como é o login hoje** — qual Cognito/IdP autentica os usuários. O login passa
  a usar o Cognito de usuário da conta de tooling; você vai precisar
  saber onde plugar as rotas `/auth/*` e se há `SessionMiddleware`.
- **Qual provider de modelo:** Bedrock, OpenAI, Anthropic direto, LangChain,
  vários.
- **Se há shutdown gracioso** (handler de SIGTERM, evento de shutdown).
- **Onde roda em produção** — se a rede não alcançar o endpoint de telemetria,
  nada chega, e testar de fora dessa rede dá falso negativo.

## 2. Peça ao humano — nunca invente, nunca reaproveite de outro projeto

- **`manifest.yaml`** ou os campos para montá-lo: `name` (o `canonical_name` do
  portal), `kind` (`agent` se chama modelo, `mcp` se só executa tools),
  `modelId` (obrigatório para `agent`), `riskTier`, `dataClassification`,
  `allowedTools`.
- **`otelEndpoint`** — o receiver da conta. **Não deduza a URL**: ela muda por
  ambiente, e apontar para a conta errada faz a telemetria sumir sem erro.
- **`serviceAccountId`** (o `client_id`) e o **`client_secret`** do service
  account de telemetria, com escopo `telemetry:write`. Confirme o escopo: um
  projeto costuma ter vários clients Cognito para fins diferentes, e usar o
  errado não dá erro na hora — só telemetria que nunca chega.
- **`tokenUrl`** — endpoint OAuth do Cognito da plataforma.
- **Cognito de usuário (tooling)** — o App Client do agente provisionado no
  install: `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`, `COGNITO_REDIRECT_URI` e, se o
  client for confidencial, `COGNITO_CLIENT_SECRET`. Saem do provisionamento
  (Factory API), não de outro projeto — a callback URL precisa bater com a
  registrada no App Client, senão o login quebra.

Esses valores saem da aba **SDK & Telemetria** do componente no portal.

## 3. Instale a partir do zip

O SDK não está no npm nem no PyPI público. Use o que veio no pacote:

```bash
# Python
pip install ./vendor/          # copie python/src/ para vendor/ no seu projeto

# Node.js
npm install ./vendor/topaz-ia-pump-evolution-<versao>.tgz
```

Para o deploy ser reproduzível, **versione o vendor no repositório** e
referencie-o no `requirements.txt` ou `package.json`. Garanta que o Dockerfile
copie o vendor e o `manifest.yaml` antes do install.

## 4. Configure

`manifest.yaml` na raiz do app — **não contém segredo**, pode ir para o git.

O `.env` do SDK **nunca** vai para o git. Confirme que o `.gitignore` cobre
`.env` e `.env.*`:

```
PUMP_EVOLUTION_ENABLED=true
PUMP_SERVICE_ACCOUNT_CLIENT_ID=<client_id>
PUMP_SERVICE_ACCOUNT_CLIENT_SECRET=<secret — Secrets Manager em produção>
PUMP_SERVICE_ACCOUNT_TOKEN_URL=<tokenUrl>

# Login do usuário no Cognito da tooling — do provisionamento:
COGNITO_DOMAIN=<https://<prefixo>.auth.<region>.amazoncognito.com>
COGNITO_CLIENT_ID=<app client do agente>
COGNITO_REDIRECT_URI=<https://<seu-app>/auth/callback>
COGNITO_CLIENT_SECRET=<secret do App Client, se confidencial — Secrets Manager>
```

Sem `PUMP_EVOLUTION_ENABLED=true` o SDK é inerte: não faz nada, não custa nada,
não quebra nada. Use isso para introduzir a mudança com segurança.

## 5. Instrumente

**Init uma vez no boot**, nunca por requisição. **Shutdown** no encerramento,
para não perder o último lote.

**Identidade do usuário (login no Cognito da tooling).** O login dos
usuários DEVE usar o Cognito de usuário provisionado na conta de tooling da
plataforma — é ele que carrega os claims de custo governados
(`custom:department`, `custom:cost_center`). Se o serviço já tem Cognito próprio,
ainda assim troque o login para o da tooling: o pool antigo não serve para
atribuição de custo.

Em FastAPI (Python), o SDK monta o login e entrega os resolvedores do middleware:

```python
from pump_evolution.integrations.cognito import CognitoLogin
from pump_evolution.integrations.fastapi import PumpIdentityMiddleware

login = CognitoLogin.from_env()   # lê COGNITO_* (passo 2/4)
login.install(app)                # /auth/login, /auth/callback, /auth/logout
app.add_middleware(
    PumpIdentityMiddleware,
    user_resolver=login.user_resolver,
    id_token_resolver=login.id_token_resolver,
)
# Requer SessionMiddleware montado (guarda state/PKCE e o id_token).
```

Em Node, use `CognitoLogin.fromEnv()` + `login.expressRoutes()` para montar
`/auth/login|callback|logout`, e por requisição propague com
`pump.withUser(login.userContextFromIdToken(req.session.pumpIdToken), () => ...)`
(ou `runWithIdentity` se o consumo for por Bearer). Não há middleware pronto no
Node.

Se o app JÁ tem um login e você não vai usar as rotas prontas, tudo bem usar as
primitivas (`authorize_url`/`exchange_code`) — mas o login **precisa** ser contra
o pool da tooling, e o `id_token_resolver` deve apontar para onde você guardou
esse `id_token`. **Sem o `id_token` do pool da tooling, o span sai com o usuário
certo e sem departamento**, e o custo fica incompleto. Se faltar alguma variável
`COGNITO_*`, pare e peça ao humano — não invente.

**Bedrock** é automático: `handle.instrument_bedrock(client)` logo após criar o
client boto3.

**Qualquer outro provider** usa `record_chat` — uma chamada, não um span
montado à mão. Existe nas duas stacks:

```python
# Python
from pump_evolution import record_chat

record_chat(model="gpt-4o", input_tokens=120, output_tokens=45, provider="openai")
```

```ts
// Node
import { recordChat } from '@topaz-ia/pump-evolution';

recordChat({ model: 'gpt-4o', inputTokens: 120, outputTokens: 45, provider: 'openai' });
```

## 6. Valide — e não confie em "subiu sem erro"

Rode o serviço e dispare **uma chamada real ao modelo**. Depois confirme, no
portal do CTA, na página do componente:

- `accepted: 1` — e **não** `accepted: 0`
- `enduser.id` com o email correto
- `cta.department` com o departamento real, não o grupo de acesso interno
- `gen_ai.usage.input_tokens` maior que zero
- `gen_ai.request.model` com o modelo realmente chamado

## Armadilhas que já custaram caro

**`202` com `accepted: 0` é descarte silencioso.** O receiver aceita o request
e joga o span fora quando não reconhece o formato — normalmente por falta de
`gen_ai.operation.name = "chat"`. A partir da 0.0.2 o SDK **Python** avisa no
logger quando isso acontece; passe um `logger` na configuração para ver. No
Node esse aviso ainda não existe — ali a validação do passo 6 é a única rede.

**Departamento não é grupo de acesso.** `Administrador` é papel no app; o
departamento vem dos claims `custom:department` ou `custom:topaz_directorate`.

**Duas identidades, ambas da plataforma.** O login do usuário usa o
Cognito de usuário na conta de **tooling** (App Client por agente, provisionado no
install); o envio de telemetria usa um service account M2M separado. São
credenciais distintas e não se cruzam entre si. Você TROCA o login do serviço para
o pool da tooling — não federe o pool antigo, não crie um trust: crie do zero se
não havia, crie na tooling e use o novo se havia.

**Rede fecha o caminho.** Se o processo roda em subnet privada sem rota para o
endpoint, o export falha em silêncio. Teste de dentro do ambiente real:

```bash
curl -X POST <otelEndpoint> -H "Content-Type: application/json" -d '{}'
# 401 significa que alcançou (falta credencial). Timeout significa rede.
```

**Falha de telemetria nunca derruba o serviço.** É por desenho. O outro lado
disso é que ela some sem avisar — por isso o passo 6 não é opcional.

## O que NÃO fazer

- Deixar o login do usuário no Cognito antigo do serviço quando ele deveria usar o
  pool da tooling (o pool antigo não carrega os claims de custo governados)
- Federar o Cognito antigo do serviço com o pool da tooling — é troca de login, não federação
- Reusar o service account M2M de telemetria como login de usuário (ou vice-versa)
- Commitar o `.env`, o `client_secret` ou o `COGNITO_CLIENT_SECRET`
- Declarar pronto sem ter visto `accepted: 1`
