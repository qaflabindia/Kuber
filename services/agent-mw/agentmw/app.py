"""Kuber agent middleware: the LLM gateway and reasoning tier (agent design 7.1).

    POST /v1/next-step   NextStep (ReAct step: a catalogue tool call or a final draft)
    POST /v1/compose     ComposeAnswer (reply from tool outputs only)
    POST /v1/classify    ClassifyFallback (masked statement line -> account from the chart)
    GET  /metrics        per-tenant request, token and cost counters (signed like every other call)
    GET  /healthz        liveness, gate status, program/artifact status; no secrets, unauthenticated

Order of checks on every /v1 call: body size, KH1 signature (401), tenant present (401),
model-processing gate (503 processing_not_approved), body schema (422), per-tenant rate and daily
token budget (429), model configured (503), bounded model call (504 on timeout, 502 on provider
error), output checks (422 with the reason), then 200 with meta. It never touches the database,
the ledger or a tool: the only outbound call is to the configured model provider.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import dspy
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, ValidationError

from .artifacts import Loaded, resolve
from .auth import AUTH_HEADER, AuthError, Claims, ReplayCache, auth_key, verify_request
from .config import Settings
from .gate import PROCESSING_HEADER, check_request, parse_processing_approval
from .limits import Limiter
from .lm import build_lm
from .programs import PROGRAMS, ProgramRejected, ProgramSpec, run_program
from .schemas import ClassifyRequest, ComposeRequest, Meta, NextStepRequest

log = logging.getLogger("agentmw")
MAX_BODY = 512 * 1024


def _err(status: int, code: str, detail: str | None = None, **extra: Any) -> JSONResponse:
    body: dict[str, Any] = {"error": code}
    if detail:
        body["detail"] = detail
    body.update(extra)
    return JSONResponse(body, status_code=status)


def load_programs(settings: Settings) -> dict[str, tuple[dspy.Module, Loaded]]:
    out: dict[str, tuple[dspy.Module, Loaded]] = {}
    for name, spec in PROGRAMS.items():
        module = spec.module()
        loaded = resolve(name, settings.artifacts_dir, settings.lock_path)
        if loaded.content is not None:
            try:
                module.load_state(loaded.content)
            except Exception as e:     # a state that does not fit this program's structure
                log.warning("artifact %s could not be applied to %s (%s); zero-shot", loaded.id, name, e)
                module, loaded = spec.module(), Loaded(None, None, None, f"{loaded.id}: state does not fit ({e})")
        out[name] = (module, loaded)
    return out


def create_app(settings: Settings | None = None, lm: Any = None, today: str | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    # Prompts carry tenant data: no DSPy response cache, on disk or in memory (and the root fs is read-only).
    dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
    app = FastAPI(title="Kuber agent middleware", docs_url=None, redoc_url=None, openapi_url=None)
    key = auth_key(settings.secret) if settings.secret and len(settings.secret) >= 32 else None
    replay = ReplayCache()
    limiter = Limiter(settings.rate_per_minute, settings.tokens_per_day, settings.price_in_per_m, settings.price_out_per_m)
    programs = load_programs(settings)
    state: dict[str, Any] = {"lm": lm}
    app.state.limiter, app.state.programs, app.state.settings = limiter, programs, settings

    def gate():
        return parse_processing_approval(settings.processing_approved, today)

    def model_name() -> str:
        lm_ = state["lm"]
        return settings.model or getattr(lm_, "model", None) or "unconfigured"

    async def authenticate(request: Request, body: bytes) -> Claims | JSONResponse:
        if key is None:
            return _err(503, "auth_not_configured", "AGENT_MW_SECRET is not set (at least 32 characters)")
        path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        try:
            return verify_request(key, replay, header=request.headers.get(AUTH_HEADER), method=request.method,
                                  path=path, body=body, issuers=settings.issuers)
        except AuthError as e:
            return _err(401, e.code, str(e))

    async def handle(request: Request, name: str, model: type[BaseModel]) -> JSONResponse:
        body = await request.body()
        if len(body) > MAX_BODY:
            return _err(413, "body_too_large")
        claims = await authenticate(request, body)
        if isinstance(claims, JSONResponse):
            return claims
        if not claims.tenant:
            return _err(401, "tenant_required", "the assertion must name a tenant")
        reason = check_request(gate(), request.headers.get(PROCESSING_HEADER))
        if reason:
            return _err(503, "processing_not_approved", reason)
        try:
            req = model.model_validate(json.loads(body or b"null"))
        except (ValueError, ValidationError) as e:
            detail = e.errors(include_url=False, include_input=False, include_context=False) if isinstance(e, ValidationError) else str(e)
            return _err(422, "invalid_request", None, errors=detail if isinstance(detail, list) else [str(detail)])
        if settings.require_artifacts and programs[name][1].id is None:
            return _err(503, "artifact_not_approved", f"no approved compiled artifact for {name}")
        denied = limiter.admit(claims.tenant)
        if denied:
            return _err(429, denied)
        if state["lm"] is None:
            state["lm"] = build_lm(settings)
        if state["lm"] is None:
            return _err(503, "model_not_configured", "AGENT_MW_MODEL is not set")
        spec: ProgramSpec = PROGRAMS[name]
        module, loaded = programs[name]
        try:
            pred, tin, tout, ms = await asyncio.wait_for(
                asyncio.to_thread(run_program, module, spec, req, state["lm"]), timeout=settings.timeout_s)
        except asyncio.TimeoutError:
            limiter.record(claims.tenant, name, "timeout", 0, 0)
            return _err(504, "model_timeout", f"no model answer within {settings.timeout_s:g}s")
        except Exception as e:  # provider or parsing failure; the message may echo prompt text, so only the type
            limiter.record(claims.tenant, name, "error", 0, 0)
            log.warning("%s failed: %s", name, type(e).__name__)
            return _err(502, "model_error", type(e).__name__)
        meta = Meta(program=name, artifactId=loaded.id, artifactHash=loaded.sha256, model=model_name(),
                    tokensIn=tin, tokensOut=tout, ms=ms).model_dump()
        try:
            out = spec.check(req, pred)
        except ProgramRejected as r:
            limiter.record(claims.tenant, name, r.code, tin, tout)
            return _err(422, r.code, r.detail, meta=meta, **r.extra)
        limiter.record(claims.tenant, name, "ok", tin, tout)
        return JSONResponse({**out, "meta": meta})

    @app.post("/v1/next-step")
    async def next_step(request: Request):
        return await handle(request, "next_step", NextStepRequest)

    @app.post("/v1/compose")
    async def compose(request: Request):
        return await handle(request, "compose", ComposeRequest)

    @app.post("/v1/classify")
    async def classify(request: Request):
        return await handle(request, "classify", ClassifyRequest)

    @app.get("/metrics")
    async def metrics(request: Request):
        claims = await authenticate(request, await request.body())
        if isinstance(claims, JSONResponse):
            return claims
        return PlainTextResponse(limiter.prometheus(gate().ok), media_type="text/plain; version=0.0.4")

    @app.get("/healthz")
    async def healthz():
        return {
            "status": "ok", "service": "agent-mw",
            "gate": gate().public(),
            "auth": {"configured": key is not None},
            "requireArtifacts": settings.require_artifacts,
            "model": {"configured": bool(settings.model or state["lm"]), "provider": (model_name().split("/")[0] if settings.model else None)},
            "programs": {n: {"mode": "compiled" if l.id else "zero-shot", "artifactId": l.id, "artifactHash": l.sha256}
                         for n, (_, l) in programs.items()},
        }

    return app
