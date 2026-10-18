"""Isolated SQLite API tests; production uses PostgreSQL."""
from collections.abc import Iterator

import pytest
from app.database import get_db
from app.main import app
from app.models import Base
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

GATEWAY_TOKEN = "gateway-local-test-token-" + "g" * 40
ACCESS_ISSUER = "https://access.example.test"
ACCESS_SUBJECT = "local-test-user"
ACCESS_EMAIL = "local-test@example.test"
TEST_ORIGIN = "http://localhost:5173"


def gateway_headers() -> dict[str, str]:
    return {"X-Tasklutein-Gateway": GATEWAY_TOKEN}


def user_headers(
    subject: str = ACCESS_SUBJECT,
    email: str = ACCESS_EMAIL,
    origin: str = TEST_ORIGIN,
) -> dict[str, str]:
    return {
        **gateway_headers(),
        "X-Tasklutein-Access-Issuer": ACCESS_ISSUER,
        "X-Tasklutein-Access-Subject": subject,
        "X-Tasklutein-Access-Email": email,
        "Origin": origin,
    }


def agent_headers(token: str) -> dict[str, str]:
    return {**gateway_headers(), "Authorization": "Bearer " + token}


def issue_agent_key(client: TestClient, name: str = "pytest Agent") -> str:
    response = client.post("/api/agent-tokens", headers=user_headers(), json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["secret"]


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("EDGE_GATEWAY_TOKEN", GATEWAY_TOKEN)
    monkeypatch.setenv("WEB_ORIGINS", TEST_ORIGIN)
    engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)

    def override_db() -> Iterator[Session]:
        with factory() as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    app.state.test_session_factory = factory
    try:
        with TestClient(app) as test_client:
            provisioned = test_client.post("/api/session/bootstrap", headers=user_headers())
            assert provisioned.status_code == 200, provisioned.text
            yield test_client
    finally:
        app.dependency_overrides.clear()
        del app.state.test_session_factory
        engine.dispose()
