"""KH1 request verification: the Python twin of packages/auth/src/index.ts.

The core signs every request to the middleware exactly as the web tier signs requests to the core:

    x-kuber-auth: KH1 <base64url(claims JSON)>.<base64url(HMAC-SHA256(key, "kuber-core-auth/v1\\n" + payload))>
    key = HKDF-SHA256(ikm=AGENT_MW_SECRET, salt="kuber", info="kuber-core-auth/v1", 32 bytes)

Claims: v, iss, aud, method, path, bh (SHA-256 of the exact body bytes), tenant, principal, sid,
iat, exp (ms; lifetime at most 60 s), nonce (16..64 chars). Audience is "kuber-agent-mw" and the
issuer "kuber-core", so an assertion made for the core can never be replayed here and vice versa
(and the secret differs as well). Each nonce is accepted once until its assertion expires.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

AUTH_HEADER = "x-kuber-auth"
AUDIENCE = "kuber-agent-mw"
ISSUER = "kuber-core"
CONTEXT = "kuber-core-auth/v1"
MAX_TTL_MS = 60_000
SKEW_MS = 30_000
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_HEADER_RE = re.compile(r"^KH1 ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$")


class AuthError(Exception):
    status_code = 401

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    out, t, i = b"", b"", 1
    while len(out) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        out += t
        i += 1
    return out[:length]


def auth_key(secret: str | bytes) -> bytes:
    s = secret.encode("utf-8") if isinstance(secret, str) else secret
    if len(s) < 32:
        raise ValueError("AGENT_MW_SECRET must be at least 32 characters")
    return _hkdf_sha256(s, b"kuber", CONTEXT.encode(), 32)


def body_hash(body: bytes | str | None) -> str:
    b = b"" if body is None else body.encode("utf-8") if isinstance(body, str) else body
    return hashlib.sha256(b).hexdigest()


def _b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _mac(key: bytes, payload: str) -> bytes:
    return hmac.new(key, f"{CONTEXT}\n{payload}".encode("utf-8"), hashlib.sha256).digest()


def now_ms() -> int:
    return int(time.time() * 1000)


class ReplayCache:
    """Nonces accepted in this process, remembered until their assertion expires (one instance only)."""

    def __init__(self, max_entries: int = 200_000):
        self._seen: dict[str, int] = {}
        self._max = max_entries
        self._lock = threading.Lock()

    def claim(self, nonce: str, expires_at: int, now: int | None = None) -> bool:
        now = now_ms() if now is None else now
        with self._lock:
            if len(self._seen) >= self._max:
                self._prune(now)
            if len(self._seen) >= self._max:
                return False                      # fail closed under a flood
            prev = self._seen.get(nonce)
            if prev is not None and prev >= now:
                return False
            self._seen[nonce] = expires_at
            return True

    def _prune(self, now: int) -> None:
        for n in [n for n, e in self._seen.items() if e < now]:
            del self._seen[n]

    def __len__(self) -> int:
        return len(self._seen)


@dataclass(frozen=True)
class Claims:
    tenant: str | None
    principal: str | None
    sid: str | None
    method: str
    path: str
    iat: int
    exp: int
    nonce: str
    iss: str


def verify_request(key: bytes, replay: ReplayCache, *, header: str | None, method: str, path: str,
                   body: bytes | None, issuers: list[str] | None = None, now: int | None = None) -> Claims:
    m = _HEADER_RE.match(header or "")
    if not m:
        raise AuthError("unauthenticated", "missing or malformed service assertion")
    payload, sig = m.group(1), m.group(2)
    try:
        given = _b64u_decode(sig)
    except ValueError:
        raise AuthError("bad_signature", "service assertion signature is invalid") from None
    if not hmac.compare_digest(given, _mac(key, payload)):
        raise AuthError("bad_signature", "service assertion signature is invalid")
    try:
        c: dict[str, Any] = json.loads(_b64u_decode(payload).decode("utf-8"))
        if not isinstance(c, dict):
            raise ValueError
    except (ValueError, UnicodeDecodeError):
        raise AuthError("unauthenticated", "service assertion is not readable") from None
    now = now_ms() if now is None else now
    if c.get("v") != 1 or c.get("aud") != AUDIENCE:
        raise AuthError("wrong_audience", "service assertion is not for the agent middleware")
    if c.get("iss") not in (issuers or [ISSUER]):
        raise AuthError("wrong_issuer", "service assertion issuer is not trusted")
    iat, exp = c.get("iat"), c.get("exp")
    if (not isinstance(iat, int) or isinstance(iat, bool) or not isinstance(exp, int) or isinstance(exp, bool)
            or exp - iat > MAX_TTL_MS or exp <= iat):
        raise AuthError("bad_lifetime", "service assertion lifetime is invalid")
    if iat > now + SKEW_MS:
        raise AuthError("not_yet_valid", "service assertion is dated in the future")
    if exp + SKEW_MS < now:
        raise AuthError("expired", "service assertion has expired")
    if c.get("method") != method.upper() or c.get("path") != path:
        raise AuthError("wrong_request", "service assertion was issued for another request")
    if not hmac.compare_digest(str(c.get("bh", "")).encode(), body_hash(body).encode()):
        raise AuthError("wrong_body", "request body does not match the service assertion")
    sid = c.get("sid")
    if sid is not None and (not isinstance(sid, str) or not SESSION_ID_RE.match(sid)):
        raise AuthError("bad_session", "service assertion session id is malformed")
    nonce = c.get("nonce")
    if not isinstance(nonce, str) or not 16 <= len(nonce) <= 64:
        raise AuthError("replayed", "service assertion was already used")
    tenant, principal = c.get("tenant"), c.get("principal")
    if tenant is not None and not isinstance(tenant, str) or principal is not None and not isinstance(principal, str):
        raise AuthError("unauthenticated", "service assertion is not readable")
    if not replay.claim(nonce, exp + SKEW_MS, now):
        raise AuthError("replayed", "service assertion was already used")
    return Claims(tenant=tenant, principal=principal, sid=sid, method=c["method"], path=c["path"],
                  iat=iat, exp=exp, nonce=nonce, iss=c["iss"])


def sign_request(key: bytes, *, method: str, path: str, body: bytes | str | None, tenant: str | None,
                 principal: str | None, issuer: str = ISSUER, audience: str = AUDIENCE, now: int | None = None,
                 ttl_ms: int = MAX_TTL_MS, nonce: str | None = None, session: str | None = None) -> str:
    """Test helper and reference: the same header TypeScript's signRequest produces for this audience."""
    import secrets
    now = now_ms() if now is None else now
    claims = {"v": 1, "iss": issuer, "aud": audience, "tenant": tenant, "principal": principal, "sid": session,
              "method": method.upper(), "path": path, "bh": body_hash(body), "iat": now,
              "exp": now + min(ttl_ms, MAX_TTL_MS), "nonce": nonce or _b64u(secrets.token_bytes(16))}
    payload = _b64u(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    return f"KH1 {payload}.{_b64u(_mac(key, payload))}"
