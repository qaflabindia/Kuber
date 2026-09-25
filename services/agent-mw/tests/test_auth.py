"""KH1 verification: the Python twin of packages/auth, including replay and expiry."""
from __future__ import annotations

import hashlib
import hmac

import pytest

from agentmw.auth import (AUDIENCE, AuthError, ReplayCache, _b64u, auth_key, sign_request, verify_request)
from conftest import SECRET, next_step_body

KEY = auth_key(SECRET)
NOW = 1_790_000_000_000

# Produced by packages/auth/src/index.ts (Node) for secret "s"*48: the two implementations must agree.
TS_KEY_HEX = "36b6c279489bbf9642ebc5762ea4a829bd773f42788a6a5b4136bd4775b30c7f"
TS_MAC_ABC = "TppFHDCmOqybycf4oJzwGMky6Sxn0JUnVC0E6ViowIc"
TS_HEADER = ("KH1 eyJ2IjoxLCJpc3MiOiJrdWJlci1jb3JlIiwiYXVkIjoia3ViZXItYWdlbnQtbXciLCJ0ZW5hbnQiOiJ0MSIsInByaW5jaXBhbCI6ImFnZW50OmNvcGlsb3QiLCJzaWQiOm51bGwsIm1ldGhvZCI6IlBPU1QiLCJwYXRoIjoiL3YxL2NsYXNzaWZ5IiwiYmgiOiIwMTVhYmQ3ZjVjYzU3YTJkZDk0Yjc1OTBmMDRhZDgwODQyNzM5MDVlZTMzZWM1Y2ViZWFlNjIyNzZhOTdmODYyIiwiaWF0IjoxNzkwMDAwMDAwMDAwLCJleHAiOjE3OTAwMDAwNjAwMDAsIm5vbmNlIjoiSWp2NmNiVjNGNFoteG1HZ1lvazRpUSJ9"
             ".6Ho-v2C13Rv3SqyCuXDOONmr9CXw8618a3wzQ5e2MiM")


def verify(header, method="POST", path="/v1/next-step", body=b"{}", now=NOW, replay=None):
    return verify_request(KEY, replay if replay is not None else ReplayCache(), header=header, method=method, path=path, body=body, now=now)


def sign(**kw):
    base = dict(method="POST", path="/v1/next-step", body=b"{}", tenant="t1", principal="agent:copilot", now=NOW)
    base.update(kw)
    return sign_request(KEY, **base)


def code(fn) -> str:
    with pytest.raises(AuthError) as e:
        fn()
    return e.value.code


def test_key_and_mac_match_typescript():
    assert KEY.hex() == TS_KEY_HEX
    mac = hmac.new(KEY, b"kuber-core-auth/v1\nabc", hashlib.sha256).digest()
    assert _b64u(mac) == TS_MAC_ABC


def test_typescript_signed_header_verifies():
    c = verify_request(KEY, ReplayCache(), header=TS_HEADER, method="POST", path="/v1/classify", body=b'{"a":1}', now=1_790_000_000_500)
    assert (c.tenant, c.principal, c.iss) == ("t1", "agent:copilot", "kuber-core")


def test_short_secret_refused():
    with pytest.raises(ValueError):
        auth_key("short")


def test_valid_request():
    c = verify(sign())
    assert c.tenant == "t1" and c.principal == "agent:copilot"


def test_replay_is_refused():
    r = ReplayCache()
    h = sign()
    verify(h, replay=r)
    assert code(lambda: verify(h, replay=r)) == "replayed"


def test_nonce_reusable_only_after_expiry():
    r = ReplayCache()
    assert r.claim("n" * 16, NOW + 10, NOW)
    assert not r.claim("n" * 16, NOW + 10, NOW + 5)
    assert r.claim("n" * 16, NOW + 100, NOW + 11)


def test_replay_cache_fails_closed_when_full():
    r = ReplayCache(max_entries=2)
    assert r.claim("a" * 16, NOW + 1000, NOW) and r.claim("b" * 16, NOW + 1000, NOW)
    assert not r.claim("c" * 16, NOW + 1000, NOW)


def test_expired_and_future_dated():
    h = sign(now=NOW - 60_000 - 30_001)
    assert code(lambda: verify(h)) == "expired"
    h = sign(now=NOW + 30_001)
    assert code(lambda: verify(h)) == "not_yet_valid"
    # within tolerated skew: accepted
    verify(sign(now=NOW - 60_000 - 29_000))


def test_lifetime_over_60s_refused():
    import json
    payload = _b64u(json.dumps({"v": 1, "iss": "kuber-core", "aud": AUDIENCE, "tenant": "t1", "principal": None, "sid": None,
                                "method": "POST", "path": "/v1/next-step", "bh": hashlib.sha256(b"{}").hexdigest(),
                                "iat": NOW, "exp": NOW + 120_000, "nonce": "x" * 22}).encode())
    from agentmw.auth import _mac
    h = f"KH1 {payload}.{_b64u(_mac(KEY, payload))}"
    assert code(lambda: verify(h)) == "bad_lifetime"


@pytest.mark.parametrize("kw,expected", [
    ({"path": "/v1/compose"}, "wrong_request"),
    ({"method": "PUT"}, "wrong_request"),
    ({"body": b'{"x":1}'}, "wrong_body"),
])
def test_bound_to_method_path_and_body(kw, expected):
    assert code(lambda: verify(sign(**kw))) == expected


def test_core_audience_assertion_is_not_accepted_here():
    assert code(lambda: verify(sign(audience="kuber-core"))) == "wrong_audience"


def test_untrusted_issuer():
    assert code(lambda: verify(sign(issuer="kuber-web"))) == "wrong_issuer"


def test_other_secret_and_tamper():
    other = sign_request(auth_key("o" * 40), method="POST", path="/v1/next-step", body=b"{}", tenant="t1", principal=None, now=NOW)
    assert code(lambda: verify(other)) == "bad_signature"
    h = sign()
    tampered = h[:-2] + ("AA" if not h.endswith("AA") else "BB")
    assert code(lambda: verify(tampered)) == "bad_signature"
    assert code(lambda: verify(None)) == "unauthenticated"
    assert code(lambda: verify("Bearer abc")) == "unauthenticated"


def test_malformed_session_id():
    assert code(lambda: verify(sign(session="bad id"))) == "bad_session"


# --------------------------------------------------------------------------- over HTTP
def test_http_unsigned_and_replayed(mw):
    r = mw.post("/v1/next-step", next_step_body(), sign=False)
    assert r.status_code == 401 and r.json()["error"] == "unauthenticated"
    raw = b'{"request":"x","catalogue":[{"name":"kuber_accounts","description":""}]}'
    h = sign_request(mw.key, method="POST", path="/v1/next-step", body=raw, tenant="t1", principal=None)
    hdr = {"x-kuber-auth": h, "x-kuber-processing-approval": "system_owner:asha:2026-09-01:us"}
    assert mw.client.post("/v1/next-step", content=raw, headers=hdr).status_code == 200
    r = mw.client.post("/v1/next-step", content=raw, headers=hdr)
    assert r.status_code == 401 and r.json()["error"] == "replayed"


def test_http_tenant_required(mw):
    r = mw.post("/v1/next-step", next_step_body(), tenant=None)
    assert r.status_code == 401 and r.json()["error"] == "tenant_required"


def test_http_no_secret_configured(tmp_path, fake_lm):
    from agentmw.app import create_app
    from conftest import Mw, make_settings
    m = Mw(create_app(make_settings(tmp_path, secret=None), lm=fake_lm))
    r = m.post("/v1/next-step", next_step_body())
    assert r.status_code == 503 and r.json()["error"] == "auth_not_configured"


def test_metrics_requires_signature(mw):
    assert mw.get("/metrics", sign=False).status_code == 401
    assert mw.get("/metrics").status_code == 200
