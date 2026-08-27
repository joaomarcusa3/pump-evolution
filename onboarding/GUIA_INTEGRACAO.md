# Guia de Integração — pump-evolution SDK (Python)

## Arquitetura de Autenticação

O SDK separa duas identidades independentes — e **ambas vivem na
plataforma**:

```
┌─────────────────────────────────────────────────────────────┐
│  AGENTE                                                       │
│                                                               │
│  Login do usuário → Cognito de USUÁRIO na conta de TOOLING    │
│       (authorization_code + PKCE; App Client por agente,      │
│        provisionado no install via Factory API)               │
│       ↓ id_token com custom:department, custom:cost_center    │
│  CognitoLogin (SDK) guarda o id_token na sessão               │
│       ↓                                                       │
│  PumpIdentityMiddleware → lê o id_token, decodifica claims    │
│       ↓                                                       │
│  SDK pump-evolution → seta enduser.id + department no span    │
│       ↓                                                       │
│  Service Account (M2M) → autentica no Cognito CTA             │
│       ↓                                                       │
│  Envia span → CTA receiver                                   │
└─────────────────────────────────────────────────────────────┘
```

**Por que o login do usuário é da plataforma.** Os claims de
custo (`custom:department`, `custom:cost_center`) só são confiáveis se a plataforma
controlar o pool que os emite. Deixá-los a cargo do Cognito de cada cliente
significava, na prática, span sem departamento e custo não atribuído. Então o
**User Pool de usuário final vive na conta de tooling**, com um App Client por
agente, e o agente troca o login dele para esse pool — crie do zero se não tinha,
crie na tooling e use o novo se tinha.

- **Cognito de usuário (tooling)** → autentica a PESSOA; carrega os claims de custo
- **Service Account (Cognito CTA, M2M)** → autentica o SDK pra ENVIAR spans

As duas credenciais são distintas e não se cruzam entre si.

## Passo a passo

### 1. Instalar

```bash
pip install ./vendor/
```

Ou se o SDK está como wheel:
```bash
pip install ./vendor/pump_evolution-0.0.2-py3-none-any.whl
```

### 2. Configurar manifest.yaml

Colocar na raiz do app (ex: `/app/manifest.yaml`):

```yaml
name: <canonical_name do portal>  # ex: tpz-cel926-meu-agente-001
kind: agent                        # ou: mcp (se for servidor MCP sem modelo)
modelId: <inference_profile_id>    # obrigatório pra kind=agent
riskTier: T3-sensitive
dataClassification: sensitive
allowedTools: []                   # lista de tools permitidas (vazio = sem check)

runtime:
  telemetry:
    otelEndpoint: <otelEndpoint — pegue na aba SDK & Telemetria do componente>
    serviceAccountId: <client_id do service account>
```

### 3. Configurar .env.pump

```env
PUMP_EVOLUTION_ENABLED=true
PUMP_OTEL_ENDPOINT=<otelEndpoint — pegue na aba SDK & Telemetria do componente>
PUMP_SERVICE_ACCOUNT_CLIENT_ID=<client_id>
PUMP_SERVICE_ACCOUNT_CLIENT_SECRET=<secret do portal - NUNCA no git>
PUMP_SERVICE_ACCOUNT_TOKEN_URL=<tokenUrl — pegue na aba SDK & Telemetria do componente>

# ─── Login do usuário: Cognito de usuário na conta de tooling ───
# Provisionado no install via Factory API (App Client por agente). Sem inventar:
# estes valores saem do provisionamento, não de outro projeto.
COGNITO_DOMAIN=<https://<prefixo>.auth.<region>.amazoncognito.com>
COGNITO_CLIENT_ID=<app client do agente no pool da tooling>
COGNITO_REDIRECT_URI=<https://<seu-app>/auth/callback — registrado no App Client>
COGNITO_CLIENT_SECRET=<secret do App Client, se confidencial — NUNCA no git>
COGNITO_LOGOUT_REDIRECT_URI=<https://<seu-app>/ — opcional>
```

### 4. Inserir no entrypoint (main.py)

#### 4.1 Imports (antes de `app = FastAPI(...)`)

```python
# --- pump-evolution (telemetria governada CTA) ---
import logging as _pump_logging
import pathlib as _pathlib
from starlette.middleware.base import BaseHTTPMiddleware as _PumpBaseMiddleware
_pump_logger = _pump_logging.getLogger("pump-evolution")
try:
    from pump_evolution import PumpEvolution
    from pump_evolution.types import PumpConfig, ServiceAccountCredentials, UserContext
    from pump_evolution.identity_context import _identity_store
    _PUMP_AVAILABLE = True
except ImportError:
    _PUMP_AVAILABLE = False
    _pump_logger.warning("[pump] SDK pump-evolution nao instalado")
_pump_handle = None

# Carrega .env.pump se existir
_env_pump_path = _pathlib.Path("/app/.env.pump")
if _env_pump_path.exists():
    for _line in _env_pump_path.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())
```

#### 4.2 Login do usuário (Cognito da tooling) + middleware de identidade

O login dos usuários passa a usar o **Cognito de usuário provisionado na conta de
tooling**. O SDK monta as rotas de login e entrega os resolvedores que
o middleware consome — uma chamada, sem copiar código:

```python
from pump_evolution.integrations.cognito import CognitoLogin
from pump_evolution.integrations.fastapi import PumpIdentityMiddleware

login = CognitoLogin.from_env()   # lê COGNITO_* do .env.pump

# Monta /auth/login, /auth/callback e /auth/logout.
# Requer SessionMiddleware montado (guarda state/PKCE e o id_token):
#   from starlette.middleware.sessions import SessionMiddleware
#   app.add_middleware(SessionMiddleware, secret_key=os.environ["SESSION_SECRET"])
login.install(app)

# O middleware lê o usuário/​id_token da sessão preenchida pelo login e propaga
# a identidade (enduser.id + department + cost_center) para todo span da request:
app.add_middleware(
    PumpIdentityMiddleware,
    user_resolver=login.user_resolver,
    id_token_resolver=login.id_token_resolver,
)
```

Fluxo: o usuário acessa `/auth/login` → Hosted UI do Cognito da tooling →
`/auth/callback` troca o código por tokens (PKCE + state) e guarda o `id_token`
na sessão → o middleware decodifica os claims e atribui cada span.

**Já tem um login próprio e não quer usar as rotas prontas?** Use as primitivas
(`login.authorize_url(...)`, `login.exchange_code(...)`) e continue passando
`user_resolver`/`id_token_resolver` apontando para onde você guardou o `id_token`.
Mas o login **precisa** ser contra o pool da tooling — é ele que carrega os claims
de custo governados; o pool antigo do agente não serve para atribuição de custo.

Por que isso importa: o grupo de acesso interno do app (`Administrador`,
`Operador`) **não** é o departamento da pessoa. O departamento real vem dos
claims `custom:department` / `custom:topaz_directorate`, emitidos pelo pool da
tooling, e é ele que sustenta o custo por centro de custo no portal.

O SDK **não valida** a assinatura do JWT ao ler os claims — a validação
aconteceu no login (troca de código sobre TLS). Só decodifica o payload.


#### 4.3 Init no startup

```python
@app.on_event("startup")
async def startup():
    # ... código existente ...

    # ── pump-evolution: init telemetria CTA ──
    global _pump_handle
    if _PUMP_AVAILABLE:
        try:
            _pump_handle = PumpEvolution.init(PumpConfig(
                manifest="/app/manifest.yaml",
                service_account=ServiceAccountCredentials(
                    client_id=os.environ.get("PUMP_SERVICE_ACCOUNT_CLIENT_ID", ""),
                    client_secret=os.environ.get("PUMP_SERVICE_ACCOUNT_CLIENT_SECRET", ""),
                    token_url=os.environ.get("PUMP_SERVICE_ACCOUNT_TOKEN_URL", ""),
                ),
            ))
            _pump_logger.info("[pump] SDK inicializado — telemetria CTA ativa")
        except Exception as _pump_e:
            _pump_logger.warning(f"[pump] falha ao inicializar: {_pump_e}")
            _pump_handle = None
```

#### 4.4 Shutdown

```python
@app.on_event("shutdown")
async def pump_shutdown():
    global _pump_handle
    if _pump_handle is not None:
        try:
            await _pump_handle.shutdown()
            _pump_logger.info("[pump] shutdown completo")
        except Exception:
            pass
```

### 5. Instrumentar LLM

#### 5.1 Bedrock (automático)

No arquivo onde cria o client boto3 (`session.client("bedrock-runtime", ...)`), adicionar LOGO APÓS:

```python
def _get_pump_handle():
    try:
        from src.main import _pump_handle
        return _pump_handle
    except Exception:
        return None

# Após criar o client:
client = session.client("bedrock-runtime", region_name=region, config=cfg)

# Instrumentar:
_ph = _get_pump_handle()
if _ph is not None:
    try:
        _ph.instrument_bedrock(client)
    except Exception:
        pass
```

O SDK intercepta `converse()` e emite span `chat` com:
- `gen_ai.operation.name = "chat"`
- `gen_ai.request.model` = modelId da chamada
- `gen_ai.usage.input_tokens` / `output_tokens`
- `enduser.id` (do contextvars propagado pelo middleware)

#### 5.2 Outros providers (OpenAI, Anthropic, SAI, LangChain)

O SDK não auto-instrumenta providers fora do Bedrock. A partir da 0.0.2, uma
chamada resolve:

```python
from pump_evolution import record_chat

resposta = await llm.ainvoke(mensagens)

record_chat(
    model=getattr(llm, "model", "desconhecido"),
    input_tokens=(resposta.usage_metadata or {}).get("input_tokens"),
    output_tokens=(resposta.usage_metadata or {}).get("output_tokens"),
    provider="openai",
)
```

Se a chamada ao modelo falhar, registre também — falha registrada vale mais
que silêncio:

```python
try:
    resposta = await llm.ainvoke(mensagens)
except Exception as erro:
    record_chat(model="gpt-4o", error=erro)
    raise
```

`record_chat` nunca levanta exceção: erro de telemetria devolve `False` e o
seu código segue.

**Por que não montar o span à mão:** o receiver do CTA só aceita spans com
`gen_ai.operation.name = "chat"`. Esquecer esse atributo faz ele responder
`202` com `accepted: 0` — request aceito, span descartado, nenhum erro visível.
Era a armadilha mais cara deste SDK, e `record_chat` existe para eliminá-la.


### 6. Dockerfile (deploy reproduzível)

```dockerfile
COPY requirements.ec2.txt requirements.txt
COPY backend/vendor/ /app/vendor/
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/manifest.yaml /app/manifest.yaml
```

E no `requirements.txt`:
```
./vendor/
```

## Pontos-chave

1. **O SDK é no-op se `PUMP_EVOLUTION_ENABLED` != `true`** — sem risco de quebrar o agente
2. **Falha de telemetria NUNCA derruba o processo** — degrada em silêncio
3. **O login do usuário usa o Cognito da tooling** — App Client por agente,
   provisionado no install; é ele que carrega os claims de custo governados
4. **Identidade vem do id_token do pool da tooling** — decodifica claims, não valida assinatura
5. **Span DEVE ter `gen_ai.operation.name = "chat"`** — sem isso o CTA não aceita (`accepted: 0`)
