"""
consumer_auth — verifica o **Bearer JWT de QUEM CHAMA** o agente/MCP contra o
JWKS do IdP (Cognito), conferindo assinatura (RS256), issuer, audience e
expiração. Paridade 1:1 com `src/consumer-auth.ts`.

Concern SEPARADO da telemetria: NÃO faz parte do `PumpHandle`. O dono chama
`ConsumerTokenVerifier.verify(bearer)` na BORDA HTTP; se ok, mapeia os claims pra
`UserContext` (`claims_to_user_context`) e propaga via `with_user`.

Invariantes (zero-trust, fail-closed): só RS256 (`alg: none`/HS* → REJEITADO);
assinatura verificada contra o JWK do `kid` do header (via `cryptography`); `iss`
deve bater; `exp` (com tolerância) obrigatório; `aud`/`client_id` deve bater
quando configurado; nunca lança pro chamador (retorna resultado + motivo); JWKS
em cache com TTL, `kid` desconhecido dispara UM refetch (rotação de chave).
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional
from urllib.request import Request, urlopen

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers

from .identity_context import claims_to_user_context, with_user
from .types import UserContext

_BEARER_RE = re.compile(r"^Bearer\s+", re.IGNORECASE)


# ─── Config & tipos ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class JwksResponse:
    ok: bool
    status: int
    payload: Any

    def json(self) -> Any:
        return self.payload


# (url, headers) -> resposta com .ok/.status/.json()
JwksFetchLike = Callable[..., Awaitable[JwksResponse]]


@dataclass(frozen=True)
class ConsumerAuthResult:
    """Resultado da verificação — nunca lança pro chamador."""

    ok: bool
    claims: Optional[Dict[str, Any]] = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class RunWithIdentityResult:
    ok: bool
    user: Optional[UserContext] = None
    value: Any = None
    reason: Optional[str] = None


# ─── Narrowing helpers ──────────────────────────────────────────────────────


def _is_record(v: Any) -> bool:
    return isinstance(v, dict)


def _read_string(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and len(v) > 0 else None


def _b64url_bytes(seg: str) -> bytes:
    pad = "=" * (-len(seg) % 4)
    return base64.urlsafe_b64decode(seg + pad)


def _decode_segment(seg: str) -> Optional[Dict[str, Any]]:
    try:
        parsed = json.loads(_b64url_bytes(seg).decode("utf-8"))
        return parsed if _is_record(parsed) else None
    except Exception:
        return None


def _parse_jwks(payload: Any) -> List[Dict[str, str]]:
    if not _is_record(payload) or not isinstance(payload.get("keys"), list):
        return []
    keys: List[Dict[str, str]] = []
    for k in payload["keys"]:
        if not _is_record(k):
            continue
        kid = _read_string(k.get("kid"))
        kty = _read_string(k.get("kty"))
        n = _read_string(k.get("n"))
        e = _read_string(k.get("e"))
        if kid is not None and kty == "RSA" and n is not None and e is not None:
            keys.append({"kid": kid, "kty": kty, "n": n, "e": e})
    return keys


def _jwk_to_public_key(n_b64: str, e_b64: str):
    n = int.from_bytes(_b64url_bytes(n_b64), "big")
    e = int.from_bytes(_b64url_bytes(e_b64), "big")
    return RSAPublicNumbers(e, n).public_key()


async def _default_fetch(url: str, headers: Optional[Dict[str, str]] = None) -> JwksResponse:
    def _do() -> JwksResponse:
        req = Request(url, headers=headers or {}, method="GET")
        try:
            with urlopen(req) as resp:  # noqa: S310 — JWKS URI derivado do issuer configurado
                status = resp.getcode() or 0
                body = resp.read().decode("utf-8")
                try:
                    payload = json.loads(body)
                except Exception:
                    payload = None
                return JwksResponse(ok=200 <= status < 300, status=status, payload=payload)
        except Exception as err:
            code = getattr(err, "code", 0) or 0
            return JwksResponse(ok=False, status=code, payload=None)

    return await asyncio.to_thread(_do)


def _default_now() -> float:
    return time.time() * 1000.0


# ─── Verifier ────────────────────────────────────────────────────────────────


class ConsumerTokenVerifier:
    """Verifica Bearer JWTs (RS256) contra o JWKS do IdP. Reusável por agente e MCP."""

    def __init__(
        self,
        *,
        issuer: str,
        jwks_uri: Optional[str] = None,
        audience: Optional[str] = None,
        clock_tolerance_sec: float = 60,
        jwks_cache_ttl_ms: float = 600_000,
        fetch_impl: Optional[JwksFetchLike] = None,
        now: Optional[Callable[[], float]] = None,
    ) -> None:
        self._issuer = issuer
        self._jwks_uri = (
            jwks_uri
            if jwks_uri is not None
            else re.sub(r"/$", "", issuer) + "/.well-known/jwks.json"
        )
        self._audience = audience
        self._clock_tolerance_sec = clock_tolerance_sec
        self._jwks_cache_ttl_ms = jwks_cache_ttl_ms
        self._fetch_impl: JwksFetchLike = fetch_impl if fetch_impl is not None else _default_fetch
        self._now = now if now is not None else _default_now
        self._cache_keys: Optional[Dict[str, Any]] = None
        self._cache_fetched_at: float = 0.0
        self._in_flight: Optional["asyncio.Future[Dict[str, Any]]"] = None

    async def verify(self, authorization_or_token: str) -> ConsumerAuthResult:
        """Verifica um header `Authorization` (com ou sem `Bearer `) ou o token cru.
        Retorna os claims validados em sucesso; fail-closed caso contrário."""
        token = _BEARER_RE.sub("", authorization_or_token).strip()
        parts = token.split(".")
        if len(parts) != 3:
            return ConsumerAuthResult(ok=False, reason="malformed token")

        header = _decode_segment(parts[0])
        payload = _decode_segment(parts[1])
        if header is None or payload is None:
            return ConsumerAuthResult(ok=False, reason="malformed token")
        if header.get("alg") != "RS256":
            return ConsumerAuthResult(ok=False, reason=f"unsupported alg: {header.get('alg')}")
        kid = _read_string(header.get("kid"))
        if kid is None:
            return ConsumerAuthResult(ok=False, reason="missing kid")

        key = await self._resolve_key(kid)
        if key is None:
            return ConsumerAuthResult(ok=False, reason="unknown signing key")

        if not self._verify_signature(parts, key):
            return ConsumerAuthResult(ok=False, reason="invalid signature")

        claim_error = self._validate_claims(payload)
        if claim_error is not None:
            return ConsumerAuthResult(ok=False, reason=claim_error)

        return ConsumerAuthResult(ok=True, claims=payload)

    async def run_with_identity(
        self,
        authorization_or_token: Optional[str],
        fn: Callable[[UserContext], Any],
    ) -> RunWithIdentityResult:
        """Um-liner pra agentes E MCPs: valida o Bearer do Cognito, extrai a
        identidade dos claims e roda `fn` JÁ DENTRO do contexto `with_user` — então
        TODA telemetria daquele fluxo sai com `enduser.id`/`cta.department`
        automáticos. O JWT original é propagado no `UserContext.token` (nunca
        emitido). Fail-closed: token ausente/inválido → ok=False e `fn` NÃO roda."""
        header = authorization_or_token or ""
        result = await self.verify(header)
        if not result.ok:
            return RunWithIdentityResult(ok=False, reason=result.reason)

        bare_token = _BEARER_RE.sub("", header).strip()
        base = claims_to_user_context(result.claims or {})
        user = UserContext(
            user_id=base.user_id,
            department=base.department,
            cost_center=base.cost_center,
            token=bare_token,
        )
        outcome = with_user(user, lambda: fn(user))
        value = await outcome if asyncio.iscoroutine(outcome) else outcome
        return RunWithIdentityResult(ok=True, user=user, value=value)

    def _verify_signature(self, parts: List[str], key: Any) -> bool:
        try:
            signing_input = f"{parts[0]}.{parts[1]}".encode("ascii")
            signature = _b64url_bytes(parts[2])
            key.verify(signature, signing_input, padding.PKCS1v15(), hashes.SHA256())
            return True
        except (InvalidSignature, Exception):
            return False

    def _validate_claims(self, payload: Dict[str, Any]) -> Optional[str]:
        now_sec = self._now() // 1000
        tol = self._clock_tolerance_sec

        if _read_string(payload.get("iss")) != self._issuer:
            return "issuer mismatch"

        exp = payload.get("exp") if isinstance(payload.get("exp"), (int, float)) else None
        if exp is None:
            return "missing exp"
        if now_sec > exp + tol:
            return "token expired"

        nbf = payload.get("nbf")
        if isinstance(nbf, (int, float)) and now_sec < nbf - tol:
            return "token not yet valid"

        if self._audience is not None and not self._audience_matches(payload):
            return "audience mismatch"

        return None

    def _audience_matches(self, payload: Dict[str, Any]) -> bool:
        aud = payload.get("aud")
        if isinstance(aud, str) and aud == self._audience:
            return True
        if isinstance(aud, list) and self._audience in aud:
            return True
        # Access tokens do Cognito trazem `client_id` em vez de `aud`.
        return _read_string(payload.get("client_id")) == self._audience

    async def _resolve_key(self, kid: str) -> Optional[Any]:
        fresh = (
            self._cache_keys is not None
            and self._now() - self._cache_fetched_at < self._jwks_cache_ttl_ms
        )
        if fresh and kid in (self._cache_keys or {}):
            return self._cache_keys[kid]
        # kid desconhecido ou cache stale → refetch uma vez (rotação de chave).
        keys = await self._refresh_jwks()
        return keys.get(kid)

    async def _refresh_jwks(self) -> Dict[str, Any]:
        if self._in_flight is None:
            self._in_flight = asyncio.ensure_future(self._fetch_and_build())
        try:
            keys = await self._in_flight
            self._cache_keys = keys
            self._cache_fetched_at = self._now()
            return keys
        finally:
            self._in_flight = None

    async def _fetch_and_build(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        try:
            res = await self._fetch_impl(self._jwks_uri)
            if not res.ok:
                return out
            for jwk in _parse_jwks(res.json()):
                try:
                    out[jwk["kid"]] = _jwk_to_public_key(jwk["n"], jwk["e"])
                except Exception:
                    pass
        except Exception:
            pass
        return out
