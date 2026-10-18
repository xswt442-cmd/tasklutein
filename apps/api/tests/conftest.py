"""Isolated SQLite tests; production uses PostgreSQL."""
from collections.abc import Iterator

import pytest
from app.database import get_db
from app.main import app
from app.models import Base
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

WEB_TOKEN = "web-local-test-token-" + "a" * 42
AGENT_TOKEN = "agent-local-test-token-" + "b" * 40


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.delenv("EDGE_GATEWAY_TOKEN", raising=False)
    monkeypatch.setenv("WEB_ACCESS_TOKEN", WEB_TOKEN)
    monkeypatch.setenv("AGENT_ACCESS_TOKEN", AGENT_TOKEN)
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
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        engine.dispose()
