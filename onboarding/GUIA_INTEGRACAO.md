# Guia de Integração — pump-evolution SDK (Python)

## Arquitetura de Autenticação

O SDK separa duas identidades completamente independentes:

```
┌─────────────────────────────────────────────────────────────┐
│  AGENTE (qualquer Cognito / SSO / IdP)                       │
│                                                               │
│  Auth Middleware do agente → resolve quem é o usuário         │
│       ↓                                                       │
│  PumpIdentityMiddleware → lê id_token guardado pelo agente   │
│       ↓ decodifica claims: custom:department, email           │
│  SDK pump-evolution → seta enduser.id + department no span    │
│       ↓                                                       │
│  Service Account (M2M) → autentica no Cognito CTA            │
│       ↓                                                       │
│  Envia span → CTA receiver                                   │
└─────────────────────────────────────────────────────────────┘
```

**O Cognito do agente e o Cognito do CTA NUNCA se cruzam.**

- Service Account (CTA Cognito) → autentica o SDK pra ENVIAR spans
- id_token (Cognito do agente) → SDK LÊ pra ATRIBUIR spans ao usuário

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

#### 4.2 Middleware de identidade (após o auth do seu app)

A partir da 0.0.2 isto é um módulo do pacote. Não copie código:

```python
from pump_evolution.integrations.fastapi import PumpIdentityMiddleware

app.add_middleware(PumpIdentityMiddleware)
```

Assim ele lê `request.state.user` — a convenção mais comum em FastAPI — e
propaga o usuário para todo span emitido durante a requisição.

**Se o seu app guarda o usuário em outro lugar**, passe um resolvedor:

```python
app.add_middleware(
    PumpIdentityMiddleware,
    user_resolver=lambda request: request.scope.get("usuario_logado"),
)
```

**Para ter `department` e `cost_center`**, o SDK precisa do `id_token` que o
seu app já guardou no login. Onde ele está varia por projeto — banco, cookie,
sessão, cabeçalho —, então entra por callback:

```python
async def buscar_id_token(request, email):
    # troque pelo seu caso: consulta ao banco, request.cookies.get("id_token"),
    # request.headers.get("Authorization"), sessão...
    return await meu_repositorio.token_de(email)

app.add_middleware(PumpIdentityMiddleware, id_token_resolver=buscar_id_token)
```

Por que isso importa: o grupo de acesso interno do app (`Administrador`,
`Operador`) **não** é o departamento da pessoa. O departamento real vem dos
claims `custom:department` / `custom:topaz_directorate` do Cognito, e é ele que
sustenta o custo por centro de custo no portal. Sem o `id_token`, o span sai
com o usuário certo e sem departamento.

O SDK **não valida** o JWT — ele confia no seu middleware de autenticação, que
já resolveu quem é a pessoa. Só decodifica o payload para ler os claims.


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
3. **Não precisa mudar nenhum Cognito** — SDK usa service account M2M separado
4. **Identidade vem do id_token que o agente já tem** — decodifica claims, não valida
5. **Span DEVE ter `gen_ai.operation.name = "chat"`** — sem isso o CTA não aceita (`accepted: 0`)
