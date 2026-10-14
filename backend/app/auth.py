"""Single-workspace, dual-credential access control.

The separate browser and agent credentials label the source of reports.
They are *not* individual user accounts or granular agent permissions.
"""
import hmac
import os
from hashlib import sha256
from typing import Literal

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

Actor = Literal["user", "agent"]
security = HTTPBearer(auto_error=False)


def actor_for_token(token: str | None, web_token: str | None, agent_token: str | None) -> Actor | None:
    if not token or not web_token or not agent_token:
        return None
    if len(web_token) < 32 or len(agent_token) < 32 or web_token == agent_token:
        return None
    digest = sha256(token.encode("utf-8")).digest()
    if hmac.compare_digest(digest, sha256(web_token.encode("utf-8")).digest()):
        return "user"
    if hmac.compare_digest(digest, sha256(agent_token.encode("utf-8")).digest()):
        return "agent"
    return None


def require_actor(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> Actor:
    web_token = os.getenv("WEB_ACCESS_TOKEN")
    agent_token = os.getenv("AGENT_ACCESS_TOKEN")
    if (
        not web_token
        or not agent_token
        or len(web_token) < 32
        or len(agent_token) < 32
        or web_token == agent_token
        or web_token.startswith("REPLACE_WITH")
        or agent_token.startswith("REPLACE_WITH")
    ):
        raise HTTPException(status_code=503, detail="server_not_configured")
    actor = actor_for_token(credentials.credentials if credentials else None, web_token, agent_token)
    if actor is None:
        raise HTTPException(status_code=401, detail="unauthorized", headers={"WWW-Authenticate": "Bearer"})
    return actor
