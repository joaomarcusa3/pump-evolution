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
    otelEndpoint: https://d3eaaghzw7ojx8.cloudfront.net/api/telemetry/v1/traces
    serviceAccountId: <client_id do service account>
```

### 3. Configurar .env.pump

```env
PUMP_EVOLUTION_ENABLED=true
PUMP_OTEL_ENDPOINT=https://d3eaaghzw7ojx8.cloudfront.net/api/telemetry/v1/traces
PUMP_SERVICE_ACCOUNT_CLIENT_ID=<client_id>
PUMP_SERVICE_ACCOUNT_CLIENT_SECRET=<secret do portal - NUNCA no git>
PUMP_SERVICE_ACCOUNT_TOKEN_URL=https://topaz-cta-dev.auth.us-east-1.amazoncognito.com/oauth2/token
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

#### 4.2 Middleware de identidade (antes do rate limiter / após auth)

```python
class PumpIdentityMiddleware(_PumpBaseMiddleware):
    async def dispatch(self, request, call_next):
        if not _PUMP_AVAILABLE or _pump_handle is None:
            return await call_next(request)
        user_state = getattr(request.state, "user", None)
        if user_state is None:
            return await call_next(request)

        user_email = getattr(user_state, "email", None) or getattr(user_state, "user_id", None)

        # Resolve department do id_token guardado (claims custom do Cognito)
        _department = None
        _cost_center = None
        try:
            import base64 as _b64, json as _json
            # ADAPTAR: onde o agente guarda o id_token do usuário
            from src.db.database import AsyncSessionLocal
            from src.db.models import Setting
            from sqlalchemy import select as _sel
            if user_email:
                async with AsyncSessionLocal() as _db:
                    _r = await _db.execute(
                        _sel(Setting).where(Setting.key == f"aws_oidc_token:{user_email}")
                    )
                    _setting = _r.scalar_one_or_none()
                    if _setting and _setting.value:
                        _parts = _setting.value.split(".")
                        if len(_parts) >= 2:
                            _pad = "=" * (-len(_parts[1]) % 4)
                            _claims = _json.loads(_b64.urlsafe_b64decode(_parts[1] + _pad))
                            _department = (
                                _claims.get("custom:department")
                                or _claims.get("custom:topaz_directorate")
                            )
                            _cost_center = (
                                _claims.get("custom:cost_center")
                                or _claims.get("custom:cta_cost_center")
                            )
        except Exception:
            pass  # nunca quebra o request por causa de telemetria

        user_ctx = UserContext(
            user_id=user_email,
            department=_department,
            cost_center=_cost_center,
        )
        token = _identity_store.set(user_ctx)
        try:
            response = await call_next(request)
        finally:
            _identity_store.reset(token)
        return response

app.add_middleware(PumpIdentityMiddleware)
```

**ADAPTAR:** O trecho que lê o id_token (`Setting.key == f"aws_oidc_token:{user_email}"`) depende de ONDE o agente guarda o JWT do login. Pode ser:
- Uma tabela `Setting` (como no SuperDoc)
- Um cookie
- Uma variável de sessão
- O header `Authorization` da request atual

O importante é **decodificar o payload do JWT** (base64 do segundo segmento) e extrair `custom:department`.

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

#### 5.2 Outros providers (OpenAI, SAI, etc.) — manual

O SDK não auto-instrumenta providers não-Bedrock. Use wrapper:

```python
# Após a chamada: response = await llm.ainvoke(messages)
try:
    from opentelemetry import trace
    from pump_evolution.constants import (
        GEN_AI_OPERATION_NAME, GEN_AI_REQUEST_MODEL,
        GEN_AI_USAGE_INPUT_TOKENS, GEN_AI_USAGE_OUTPUT_TOKENS,
        CTA_USAGE_TOKENS_AVAILABLE,
    )
    from pump_evolution.identity_context import apply_identity_to_span

    tracer = trace.get_tracer("pump-evolution")
    model_name = getattr(llm, "model", "unknown")

    # Extrair tokens da resposta LangChain
    input_tokens = 0
    output_tokens = 0
    if hasattr(response, "usage_metadata") and response.usage_metadata:
        input_tokens = response.usage_metadata.get("input_tokens", 0)
        output_tokens = response.usage_metadata.get("output_tokens", 0)

    with tracer.start_as_current_span(f"chat {model_name}", kind=trace.SpanKind.CLIENT) as span:
        span.set_attribute(GEN_AI_OPERATION_NAME, "chat")
        span.set_attribute(GEN_AI_REQUEST_MODEL, str(model_name))
        if input_tokens or output_tokens:
            span.set_attribute(GEN_AI_USAGE_INPUT_TOKENS, input_tokens)
            span.set_attribute(GEN_AI_USAGE_OUTPUT_TOKENS, output_tokens)
            span.set_attribute(CTA_USAGE_TOKENS_AVAILABLE, True)
        apply_identity_to_span(span)
        span.set_status(trace.Status(trace.StatusCode.OK))
except Exception:
    pass
```

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
