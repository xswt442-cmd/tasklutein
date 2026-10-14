"""ASGI application. API services run on the Tencent Cloud host."""
import hmac
import os
from hashlib import sha256

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .routers.reports import router as report_router
from .routers.tasks import router as task_router

app = FastAPI(
    title="Tasklutein API",
    description="Task and progress report API for people and MCP agents.",
    version="0.1.0",
)

origins = [origin.strip() for origin in os.getenv("WEB_ORIGINS", "http://localhost:5173").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def require_edge_gateway(request: Request, call_next):
    # This check is independent of user/agent Bearer auth. Production Docker
    # requires EDGE_GATEWAY_TOKEN; local development may omit it.
    if request.url.path.startswith("/api/"):
        expected = os.getenv("EDGE_GATEWAY_TOKEN")
        if expected is not None:
            if len(expected) < 32 or expected.startswith("REPLACE_WITH"):
                return JSONResponse({"detail": "gateway_not_configured"}, status_code=503)
            supplied = request.headers.get("X-Tasklutein-Gateway", "")
            left = sha256(supplied.encode("utf-8")).digest()
            right = sha256(expected.encode("utf-8")).digest()
            if not supplied or not hmac.compare_digest(left, right):
                return JSONResponse(
                    {"detail": "invalid_gateway"}, status_code=403,
                    headers={"Cache-Control": "no-store"}
                )
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/api/health", tags=["health"])
def health():
    return {"status": "ok", "service": "tasklutein"}


app.include_router(task_router)
app.include_router(report_router)
