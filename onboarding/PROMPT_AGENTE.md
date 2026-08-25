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
- **Onde o app guarda o `id_token` do login** — banco, cookie, sessão,
  cabeçalho. Pode não guardar; siga assim mesmo e avise o humano do efeito
  (ver passo 5).
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
```

Sem `PUMP_EVOLUTION_ENABLED=true` o SDK é inerte: não faz nada, não custa nada,
não quebra nada. Use isso para introduzir a mudança com segurança.

## 5. Instrumente

**Init uma vez no boot**, nunca por requisição. **Shutdown** no encerramento,
para não perder o último lote.

**Identidade do usuário** — em FastAPI, use o módulo pronto:

```python
from pump_evolution.integrations.fastapi import PumpIdentityMiddleware

app.add_middleware(PumpIdentityMiddleware)
```

Se o app guarda o usuário fora de `request.state.user`, passe `user_resolver`.
Se guarda o `id_token`, passe `id_token_resolver` — é o que traz `department` e
`cost_center` para os spans. **Sem o `id_token`, o span sai com o usuário certo
e sem departamento**, e o custo por centro de custo fica incompleto. Avise o
humano se for esse o caso.

**Bedrock** é automático: `handle.instrument_bedrock(client)` logo após criar o
client boto3.

**Qualquer outro provider** usa `record_chat` — uma chamada, não um span
montado à mão:

```python
from pump_evolution import record_chat

record_chat(model="gpt-4o", input_tokens=120, output_tokens=45, provider="openai")
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
`gen_ai.operation.name = "chat"`. A partir da 0.0.2 o SDK avisa no logger
quando isso acontece; passe um `logger` na configuração para ver.

**Departamento não é grupo de acesso.** `Administrador` é papel no app; o
departamento vem dos claims `custom:department` ou `custom:topaz_directorate`.

**Dois Cognitos não se cruzam.** O serviço mantém o login dele, seja qual for o
provedor. O SDK usa um service account separado só para enviar telemetria. Não
federe nada, não crie usuário no Cognito da plataforma, não altere o auth do
app.

**Rede fecha o caminho.** Se o processo roda em subnet privada sem rota para o
endpoint, o export falha em silêncio. Teste de dentro do ambiente real:

```bash
curl -X POST <otelEndpoint> -H "Content-Type: application/json" -d '{}'
# 401 significa que alcançou (falta credencial). Timeout significa rede.
```

**Falha de telemetria nunca derruba o serviço.** É por desenho. O outro lado
disso é que ela some sem avisar — por isso o passo 6 não é opcional.

## O que NÃO fazer

- Federar Cognitos entre o serviço e a plataforma
- Mudar o login do serviço
- Criar usuários no Cognito da plataforma
- Alterar claims no Cognito do serviço
- Commitar o `.env` ou o `client_secret`
- Declarar pronto sem ter visto `accepted: 1`
