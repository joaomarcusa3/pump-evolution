"""
middleware_fastapi.py — Middleware pronto pra FastAPI
Copie e ADAPTE o trecho marcado com "ADAPTAR" pro seu agente.
"""
import os
import logging
import pathlib
from starlette.middleware.base import BaseHTTPMiddleware

_pump_logger = logging.getLogger("pump-evolution")

# ── Imports do SDK (graceful se não instalado) ──
try:
    from pump_evolution import PumpEvolution
    from pump_evolution.types import PumpConfig, ServiceAccountCredentials, UserContext
    from pump_evolution.identity_context import _identity_store
    _PUMP_AVAILABLE = True
except ImportError:
    _PUMP_AVAILABLE = False
    _pump_logger.warning("[pump] SDK pump-evolution nao instalado")

_pump_handle = None

# ── Loader de .env.pump ──
_env_pump_path = pathlib.Path("/app/.env.pump")  # ADAPTAR: path do .env.pump
if _env_pump_path.exists():
    for _line in _env_pump_path.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())


# ── Init (chamar no startup do FastAPI) ──
async def init_pump_telemetry():
    """Chamar dentro do @app.on_event('startup')."""
    global _pump_handle
    if not _PUMP_AVAILABLE:
        return
    try:
        _pump_handle = PumpEvolution.init(PumpConfig(
            manifest="/app/manifest.yaml",  # ADAPTAR: path do manifest
            service_account=ServiceAccountCredentials(
                client_id=os.environ.get("PUMP_SERVICE_ACCOUNT_CLIENT_ID", ""),
                client_secret=os.environ.get("PUMP_SERVICE_ACCOUNT_CLIENT_SECRET", ""),
                token_url=os.environ.get("PUMP_SERVICE_ACCOUNT_TOKEN_URL", ""),
            ),
        ))
        _pump_logger.info("[pump] SDK inicializado — telemetria CTA ativa")
    except Exception as e:
        _pump_logger.warning(f"[pump] falha ao inicializar: {e}")
        _pump_handle = None


# ── Shutdown (chamar no @app.on_event('shutdown')) ──
async def shutdown_pump_telemetry():
    global _pump_handle
    if _pump_handle is not None:
        try:
            await _pump_handle.shutdown()
            _pump_logger.info("[pump] shutdown completo")
        except Exception:
            pass


# ── Middleware de identidade ──
class PumpIdentityMiddleware(BaseHTTPMiddleware):
    """Propaga identidade do usuário logado para telemetria.
    Lê o id_token guardado pelo agente e extrai claims custom.
    ADAPTAR: onde o agente guarda o id_token."""

    async def dispatch(self, request, call_next):
        if not _PUMP_AVAILABLE or _pump_handle is None:
            return await call_next(request)

        # ADAPTAR: como seu agente expõe o user logado
        user_state = getattr(request.state, "user", None)
        if user_state is None:
            return await call_next(request)

        user_email = (
            getattr(user_state, "email", None)
            or getattr(user_state, "user_id", None)
        )

        # Resolve department/cost_center do id_token
        _department = None
        _cost_center = None
        try:
            import base64, json

            # ══════════════════════════════════════════════════════
            # ADAPTAR: como buscar o id_token do usuário logado
            # Exemplos:
            #   - Banco (Setting): SELECT value WHERE key = 'aws_oidc_token:{email}'
            #   - Cookie: request.cookies.get("id_token")
            #   - Header: request.headers.get("Authorization").split(" ")[1]
            #   - Sessão: request.state.user.id_token
            # ══════════════════════════════════════════════════════
            from src.db.database import AsyncSessionLocal
            from src.db.models import Setting
            from sqlalchemy import select

            if user_email:
                async with AsyncSessionLocal() as db:
                    r = await db.execute(
                        select(Setting).where(
                            Setting.key == f"aws_oidc_token:{user_email}"
                        )
                    )
                    setting = r.scalar_one_or_none()
                    if setting and setting.value:
                        parts = setting.value.split(".")
                        if len(parts) >= 2:
                            pad = "=" * (-len(parts[1]) % 4)
                            claims = json.loads(
                                base64.urlsafe_b64decode(parts[1] + pad)
                            )
                            _department = (
                                claims.get("custom:department")
                                or claims.get("custom:topaz_directorate")
                            )
                            _cost_center = (
                                claims.get("custom:cost_center")
                                or claims.get("custom:cta_cost_center")
                            )
        except Exception:
            pass  # nunca quebra o request por telemetria

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


# ── Helper pra instrumentar Bedrock ──
def get_pump_handle():
    """Retorna o handle global ou None."""
    return _pump_handle


def instrument_bedrock_client(client):
    """Instrumenta um client boto3 bedrock-runtime. Chamar após session.client()."""
    if _pump_handle is not None:
        try:
            _pump_handle.instrument_bedrock(client)
        except Exception:
            pass
    return client
