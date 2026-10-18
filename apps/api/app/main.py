"""ASGI application. API services run on the Tencent Cloud host."""
import hmac
import json
import logging
import os
import re
from hashlib import sha256
from time import perf_counter
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi import status as http_status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from .auth import Principal, require_principal
from .database import get_db
from .routers.activities import router as activity_router
from .routers.agent_tokens import router as agent_token_router
from .routers.history import router as history_router
from .routers.overview import router as overview_router
from .routers.reports import router as report_router
from .routers.session import router as session_router
from .routers.tasks import router as task_router

app = FastAPI(
    title="Tasklutein API",
    description="Task and progress report API for people and MCP agents.",
    version="0.1.0",
)

origins = [origin.strip() for origin in os.getenv("WEB_ORIGINS", "http://localhost:5173").split(",") if origin.strip()]
logger = logging.getLogger("tasklutein.api")
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    logger.addHandler(handler)
logger.propagate = False
_SAFE_ERROR_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_MAX_REST_REQUEST_BYTES = 64 * 1024
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


def request_id_for(request: Request) -> str:
    request_id = getattr(request.state, "request_id", None)
    return request_id if request_id else str(uuid4())


def error_code(detail: object) -> str:
    if isinstance(detail, str) and _SAFE_ERROR_CODE.fullmatch(detail):
        return detail
    return "request_error"


@app.exception_handler(HTTPException)
async def handle_http_error(request: Request, exc: HTTPException):
    request_id = request_id_for(request)
    return JSONResponse(
        {
            "detail": exc.detail,
            "code": error_code(exc.detail),
            "request_id": request_id,
        },
        status_code=exc.status_code,
        headers=exc.headers,
    )


@app.exception_handler(OperationalError)
async def handle_database_unavailable(request: Request, _exc: OperationalError):
    request_id = request_id_for(request)
    return JSONResponse(
        {"detail": "database_unavailable", "code": "database_unavailable", "request_id": request_id},
        status_code=503,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Request-ID": request_id,
        },
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request: Request, exc: RequestValidationError):
    request_id = request_id_for(request)
    details = [
        {
            "type": str(error.get("type", "value_error")),
            "loc": [str(part) for part in error.get("loc", ())],
            "msg": str(error.get("msg", "Invalid input")),
        }
        for error in exc.errors()
    ]
    return JSONResponse(
        {"detail": details, "code": "validation_error", "request_id": request_id},
        status_code=422,
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, _exc: Exception):
    request_id = request_id_for(request)
    logger.error(json.dumps({
        "event": "request_failed",
        "request_id": request_id,
        "method": request.method,
        "status": http_status.HTTP_500_INTERNAL_SERVER_ERROR,
    }, separators=(",", ":")))
    return JSONResponse(
        {"detail": "internal_error", "code": "internal_error", "request_id": request_id},
        status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Request-ID": request_id,
        },
    )


@app.middleware("http")
async def require_edge_gateway(request: Request, call_next):
    started = perf_counter()
    supplied_request_id = request.headers.get("X-Request-ID", "")
    expected = os.getenv("EDGE_GATEWAY_TOKEN")

    # This check is independent of user/agent Bearer auth. Production Docker
    # requires EDGE_GATEWAY_TOKEN; local development may omit it.
    if request.url.path.startswith("/api/"):
        request.state.gateway_verified = False
        if expected is not None:
            if len(expected) < 32 or expected.startswith("REPLACE_WITH"):
                request_id = str(uuid4())
                return JSONResponse(
                    {"detail": "gateway_not_configured", "code": "gateway_not_configured", "request_id": request_id},
                    status_code=503,
                    headers={"Cache-Control": "no-store", "X-Request-ID": request_id},
                )
            supplied = request.headers.get("X-Tasklutein-Gateway", "")
            left = sha256(supplied.encode("utf-8")).digest()
            right = sha256(expected.encode("utf-8")).digest()
            if not supplied or not hmac.compare_digest(left, right):
                request_id = str(uuid4())
                return JSONResponse(
                    {"detail": "invalid_gateway", "code": "invalid_gateway", "request_id": request_id},
                    status_code=403,
                    headers={"Cache-Control": "no-store", "X-Request-ID": request_id},
                )
            request.state.gateway_verified = True
    trusted_request_id = getattr(request.state, "gateway_verified", False)
    try:
        request_id = str(UUID(supplied_request_id)) if trusted_request_id and supplied_request_id else str(uuid4())
    except ValueError:
        request_id = str(uuid4())
    request.state.request_id = request_id

    content_length = request.headers.get("content-length")
    if request.url.path.startswith("/api/") and content_length and content_length.isdecimal():
        if int(content_length) > _MAX_REST_REQUEST_BYTES:
            return JSONResponse(
                {"detail": "request_too_large", "code": "request_too_large", "request_id": request_id},
                status_code=413,
                headers={"Cache-Control": "no-store", "X-Request-ID": request_id},
            )

    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Request-ID"] = request_id
    route = request.scope.get("route")
    route_path = getattr(route, "path", "unmatched")
    if request.url.path.startswith("/api/"):
        logger.info(json.dumps({
            "event": "request_complete",
            "request_id": request_id,
            "method": request.method,
            "route": route_path,
            "status": response.status_code,
            "duration_ms": round((perf_counter() - started) * 1000, 2),
        }, separators=(",", ":")))
    return response


@app.get("/api/health", tags=["health"])
def health():
    return {"status": "ok", "service": "tasklutein"}


@app.get("/api/ready", tags=["health"])
def ready(
    _principal: Principal = Depends(require_principal),
    db: Session = Depends(get_db),
):
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="database_unavailable") from exc
    return {"status": "ready"}


app.include_router(session_router)
app.include_router(agent_token_router)
app.include_router(activity_router)
app.include_router(history_router)
app.include_router(task_router)
app.include_router(report_router)
app.include_router(overview_router)
