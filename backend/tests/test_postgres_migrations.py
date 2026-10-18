"""Migration and API integration checks against a disposable PostgreSQL database."""
import os
import socketserver
import threading
from collections.abc import Iterator
from pathlib import Path
from time import perf_counter, sleep

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from app.database import get_session_factory
from app.main import app
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError

WEB_TOKEN = "web-postgres-test-token-" + "a" * 40
AGENT_TOKEN = "agent-postgres-test-token-" + "b" * 40
TEST_DATABASE_URL = os.getenv("TASKLUTEIN_TEST_DATABASE_URL")
REQUIRED = os.getenv("TASKLUTEIN_REQUIRE_POSTGRES") == "1"


if not TEST_DATABASE_URL:
    if REQUIRED:
        raise RuntimeError("TASKLUTEIN_TEST_DATABASE_URL is required for PostgreSQL checks")
    pytest.skip("set TASKLUTEIN_TEST_DATABASE_URL to run PostgreSQL checks", allow_module_level=True)

database_url = make_url(TEST_DATABASE_URL)
if (
    database_url.get_backend_name() != "postgresql"
    or database_url.database != os.getenv("TASKLUTEIN_TEST_DATABASE_NAME")
    or not database_url.database
    or not database_url.database.endswith("_test")
    or database_url.host not in {"127.0.0.1", "localhost", "postgres"}
    or os.getenv("TASKLUTEIN_ALLOW_POSTGRES_TEST_RESET") != "1"
):
    raise RuntimeError("PostgreSQL checks require an explicitly resettable local database ending in _test")


@pytest.fixture()
def postgres_database(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    engine = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    try:
        with engine.begin() as connection:
            connection.execute(text("DROP TABLE IF EXISTS reports CASCADE"))
            connection.execute(text("DROP TABLE IF EXISTS tasks CASCADE"))
            connection.execute(text("DROP TABLE IF EXISTS alembic_version CASCADE"))

        monkeypatch.setenv("DATABASE_URL", TEST_DATABASE_URL)
        monkeypatch.setenv("WEB_ACCESS_TOKEN", WEB_TOKEN)
        monkeypatch.setenv("AGENT_ACCESS_TOKEN", AGENT_TOKEN)
        monkeypatch.delenv("EDGE_GATEWAY_TOKEN", raising=False)
        get_session_factory.cache_clear()
        app.dependency_overrides.clear()
        yield TEST_DATABASE_URL
    finally:
        app.dependency_overrides.clear()
        get_session_factory.cache_clear()
        with engine.begin() as connection:
            connection.execute(text("DROP TABLE IF EXISTS reports CASCADE"))
            connection.execute(text("DROP TABLE IF EXISTS tasks CASCADE"))
            connection.execute(text("DROP TABLE IF EXISTS alembic_version CASCADE"))
        engine.dispose()


def alembic_config() -> Config:
    return Config(str(Path(__file__).parents[1] / "alembic.ini"))


def headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_empty_postgres_upgrades_and_serves_real_api(postgres_database: str):
    command.upgrade(alembic_config(), "head")

    with TestClient(app) as client:
        created = client.post("/api/tasks", headers=headers(WEB_TOKEN), json={"title": "PostgreSQL migration"})
        assert created.status_code == 201
        task = created.json()["task"]

        report = client.post(
            f"/api/tasks/{task['id']}/reports",
            headers=headers(AGENT_TOKEN),
            json={"content": "Created through FastAPI on PostgreSQL."},
        )
        assert report.status_code == 201
        assert report.json()["report"]["source"] == "agent"

        for index in range(100):
            response = client.post(
                f"/api/tasks/{task['id']}/reports",
                headers=headers(AGENT_TOKEN),
                json={"content": f"PostgreSQL report {index}."},
            )
            assert response.status_code == 201

        report_page = client.get(f"/api/tasks/{task['id']}/reports", headers=headers(WEB_TOKEN))
        assert report_page.status_code == 200
        assert report_page.json()["total"] == 101
        assert len(report_page.json()["reports"]) == 100
        last_report_page = client.get(
            f"/api/tasks/{task['id']}/reports", headers=headers(WEB_TOKEN), params={"limit": 10, "offset": 100}
        )
        assert last_report_page.status_code == 200
        assert last_report_page.json()["reports"][0]["id"] == report.json()["report"]["id"]

        for index in range(201):
            response = client.post(
                "/api/tasks",
                headers=headers(WEB_TOKEN),
                json={"title": f"PostgreSQL task {index}"},
            )
            assert response.status_code == 201

        last_task_page = client.get("/api/tasks", headers=headers(WEB_TOKEN), params={"limit": 200, "offset": 200})
        assert last_task_page.status_code == 200
        assert last_task_page.json()["total"] == 202
        assert len(last_task_page.json()["tasks"]) == 2
        overview = client.get("/api/overview", headers=headers(WEB_TOKEN))
        assert overview.status_code == 200
        assert overview.json()["total"] == 202
        assert overview.json()["by_status"] == {"todo": 202, "in_progress": 0, "done": 0}

        read_back = client.get(f"/api/tasks/{task['id']}/reports", headers=headers(WEB_TOKEN))
        assert read_back.status_code == 200
        assert read_back.json()["total"] == 101

    command.check(alembic_config())


def test_existing_initial_schema_can_be_stamped_without_losing_api_data(postgres_database: str):
    initial_schema = Path(__file__).parents[2] / "migrations" / "0001_init.sql"
    connection_url = database_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(connection_url) as connection:
        connection.execute(initial_schema.read_text(encoding="utf-8"), prepare=False)

    with TestClient(app) as client:
        created = client.post("/api/tasks", headers=headers(WEB_TOKEN), json={"title": "Existing records survive stamp"})
        assert created.status_code == 201
        task = created.json()["task"]
        task_id = task["id"]
        created_report = client.post(
            f"/api/tasks/{task_id}/reports",
            headers=headers(AGENT_TOKEN),
            json={"content": "This report exists before Alembic adopts the schema."},
        )
        assert created_report.status_code == 201
        report = created_report.json()["report"]

        before_stamp = client.get("/api/tasks", headers=headers(WEB_TOKEN))
        assert before_stamp.status_code == 200
        assert [task["id"] for task in before_stamp.json()["tasks"]] == [task_id]

        schema_engine = create_engine(TEST_DATABASE_URL)
        with schema_engine.connect() as connection:
            indexes = connection.execute(
                text("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname")
            ).scalars().all()
            defaults = connection.execute(
                text("""
                    SELECT table_name, column_name, column_default
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name IN ('tasks', 'reports')
                """)
            ).all()
            cascade = connection.execute(
                text("SELECT confdeltype FROM pg_constraint WHERE conname = 'reports_task_id_fkey'")
            ).scalar_one()
        schema_engine.dispose()

        assert any("(updated_at DESC)" in index for index in indexes)
        assert any("(task_id, created_at DESC)" in index for index in indexes)
        assert {column for _, column, _ in defaults} >= {
            "description", "status", "created_at", "updated_at"
        }
        assert cascade == "c"

        command.stamp(alembic_config(), "0001_baseline")
        command.upgrade(alembic_config(), "head")
        command.check(alembic_config())

        after_stamp = client.get("/api/tasks", headers=headers(WEB_TOKEN))
        assert after_stamp.status_code == 200
        assert after_stamp.json()["tasks"] == before_stamp.json()["tasks"]
        preserved_reports = client.get(f"/api/tasks/{task_id}/reports", headers=headers(WEB_TOKEN))
        assert preserved_reports.status_code == 200
        assert preserved_reports.json()["reports"] == [report]


def test_postgres_ready_has_bounded_connection_and_query_timeouts(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    factory = get_session_factory()
    engine = factory.kw["bind"]

    started = perf_counter()
    with pytest.raises(SQLAlchemyError):
        with engine.connect() as connection:
            connection.execute(text("SELECT pg_sleep(6)"))
    assert perf_counter() - started < 5

    class StalledPostgresHandler(socketserver.BaseRequestHandler):
        def handle(self):
            # Accept the TCP connection but never answer PostgreSQL's startup probe.
            sleep(5)

    class StalledPostgresServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = StalledPostgresServer(("127.0.0.1", 0), StalledPostgresHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    stalled_url = make_url(postgres_database).set(host="127.0.0.1", port=server.server_address[1])
    monkeypatch_url = stalled_url.render_as_string(hide_password=False)
    previous_url = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = monkeypatch_url
    get_session_factory.cache_clear()
    started = perf_counter()
    try:
        with TestClient(app) as client:
            response = client.get("/api/ready", headers=headers(WEB_TOKEN))
        elapsed = perf_counter() - started
        assert response.status_code == 503
        assert response.json()["code"] == "database_unavailable"
        assert elapsed < 5
    finally:
        stalled_factory = get_session_factory()
        stalled_factory.kw["bind"].dispose()
        get_session_factory.cache_clear()
        if previous_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous_url
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=1)
        get_session_factory()
