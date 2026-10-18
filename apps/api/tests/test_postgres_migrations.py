"""Migration and API integration checks against a disposable PostgreSQL database."""
import os
import socketserver
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from time import perf_counter, sleep
from uuid import uuid4

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

GATEWAY_TOKEN = "gateway-postgres-test-token-" + "g" * 40
ACCESS_ISSUER = "https://access.example.test"
TEST_ORIGIN = "http://localhost:5173"
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


def _drop_test_schema(engine) -> None:
    with engine.begin() as connection:
        for table in ("reports", "agent_tokens", "tasks", "workspaces", "users", "alembic_version"):
            connection.execute(text(f"DROP TABLE IF EXISTS {table} CASCADE"))


@pytest.fixture()
def postgres_database(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    engine = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    _drop_test_schema(engine)
    monkeypatch.setenv("DATABASE_URL", TEST_DATABASE_URL)
    monkeypatch.setenv("EDGE_GATEWAY_TOKEN", GATEWAY_TOKEN)
    monkeypatch.setenv("WEB_ORIGINS", TEST_ORIGIN)
    for name in (
        "TASKLUTEIN_LEGACY_OWNER_ISSUER",
        "TASKLUTEIN_LEGACY_OWNER_SUBJECT",
        "TASKLUTEIN_LEGACY_OWNER_EMAIL",
        "TASKLUTEIN_LEGACY_TASKS_CONFIRM",
    ):
        monkeypatch.delenv(name, raising=False)
    get_session_factory.cache_clear()
    app.dependency_overrides.clear()
    try:
        yield TEST_DATABASE_URL
    finally:
        app.dependency_overrides.clear()
        get_session_factory.cache_clear()
        _drop_test_schema(engine)
        engine.dispose()


def alembic_config() -> Config:
    return Config(str(Path(__file__).parents[1] / "alembic.ini"))


def user_headers(subject: str, email: str) -> dict[str, str]:
    return {
        "X-Tasklutein-Gateway": GATEWAY_TOKEN,
        "X-Tasklutein-Access-Issuer": ACCESS_ISSUER,
        "X-Tasklutein-Access-Subject": subject,
        "X-Tasklutein-Access-Email": email,
        "Origin": TEST_ORIGIN,
    }


def agent_headers(secret: str) -> dict[str, str]:
    return {"X-Tasklutein-Gateway": GATEWAY_TOKEN, "Authorization": f"Bearer {secret}"}


def bootstrap(client: TestClient, subject: str, email: str) -> dict:
    response = client.post("/api/session/bootstrap", headers=user_headers(subject, email))
    assert response.status_code == 200, response.text
    return response.json()


def issue_agent_key(client: TestClient, identity_headers: dict[str, str], name: str) -> tuple[str, str]:
    response = client.post("/api/agent-tokens", headers=identity_headers, json={"name": name})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["secret"].startswith("tlu_")
    assert "secret" not in body["token"]
    return body["secret"], body["token"]["id"]


def test_empty_postgres_upgrade_isolates_users_and_tracks_report_provenance(postgres_database: str):
    command.upgrade(alembic_config(), "head")

    with TestClient(app) as client:
        alice_headers = user_headers("alice-subject", "alice@example.test")
        bob_headers = user_headers("bob-subject", "bob@example.test")
        alice = bootstrap(client, "alice-subject", "alice@example.test")
        bob = bootstrap(client, "bob-subject", "bob@example.test")
        assert alice["workspace"]["id"] != bob["workspace"]["id"]

        created = client.post("/api/tasks", headers=alice_headers, json={"title": "Alice private task"})
        assert created.status_code == 201, created.text
        task = created.json()["task"]
        assert client.get(f"/api/tasks/{task['id']}", headers=bob_headers).status_code == 404
        bob_tasks = client.get("/api/tasks", headers=bob_headers)
        assert bob_tasks.status_code == 200
        assert bob_tasks.json()["total"] == 0
        bob_overview = client.get("/api/overview", headers=bob_headers)
        assert bob_overview.status_code == 200
        assert bob_overview.json()["total"] == 0

        alice_key_one, alice_key_one_id = issue_agent_key(client, alice_headers, "Alice key one")
        alice_key_two, alice_key_two_id = issue_agent_key(client, alice_headers, "Alice key two")
        assert alice_key_one != alice_key_two
        first_report = client.post(
            f"/api/tasks/{task['id']}/reports",
            headers=agent_headers(alice_key_one),
            json={"content": "Reported by the first key."},
        )
        assert first_report.status_code == 201, first_report.text
        report_id = first_report.json()["report"]["id"]
        with create_engine(postgres_database).connect() as connection:
            provenance = connection.execute(
                text("SELECT actor_user_id, agent_token_id, source FROM reports WHERE id = :id"),
                {"id": report_id},
            ).one()
        assert str(provenance.actor_user_id) == alice["user"]["id"]
        assert str(provenance.agent_token_id) == alice_key_one_id
        assert provenance.source == "agent"

        revoked = client.delete(f"/api/agent-tokens/{alice_key_one_id}", headers=alice_headers)
        assert revoked.status_code == 204
        assert client.get("/api/agent/whoami", headers=agent_headers(alice_key_one)).status_code == 401
        still_valid = client.get("/api/agent/whoami", headers=agent_headers(alice_key_two))
        assert still_valid.status_code == 200, still_valid.text
        assert still_valid.json()["agent_token_id"] == alice_key_two_id
        assert client.get(f"/api/tasks/{task['id']}/reports", headers=bob_headers).status_code == 404

        with create_engine(postgres_database).begin() as connection:
            connection.execute(
                text("UPDATE users SET disabled_at = now() WHERE id = :user_id"),
                {"user_id": alice["user"]["id"]},
            )
        assert client.get("/api/tasks", headers=alice_headers).status_code == 403
        assert client.post("/api/session/bootstrap", headers=alice_headers).status_code == 403
        assert client.get("/api/agent/whoami", headers=agent_headers(alice_key_two)).status_code == 403

    command.check(alembic_config())


def test_existing_initial_sql_rows_survive_controlled_workspace_backfill(postgres_database: str, monkeypatch):
    initial_schema = Path(__file__).parents[1] / "migrations" / "0001_init.sql"
    task_id = uuid4()
    report_id = uuid4()
    connection_url = database_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(connection_url) as connection:
        connection.execute(initial_schema.read_text(encoding="utf-8"), prepare=False)
        connection.execute(
            "INSERT INTO tasks (id, title, description, status) VALUES (%s, %s, %s, %s)",
            (task_id, "Legacy task", "Keep this description", "in_progress"),
        )
        connection.execute(
            "INSERT INTO reports (id, task_id, content, source) VALUES (%s, %s, %s, %s)",
            (report_id, task_id, "Legacy report", "agent"),
        )

    command.stamp(alembic_config(), "0001_baseline")
    command.upgrade(alembic_config(), "0002_identity_workspace")
    with TestClient(app) as client:
        owner_headers = user_headers("legacy-owner", "legacy-owner@example.test")
        owner = bootstrap(client, "legacy-owner", "legacy-owner@example.test")

    monkeypatch.setenv("TASKLUTEIN_LEGACY_OWNER_ISSUER", ACCESS_ISSUER)
    monkeypatch.setenv("TASKLUTEIN_LEGACY_OWNER_SUBJECT", "legacy-owner")
    monkeypatch.setenv("TASKLUTEIN_LEGACY_OWNER_EMAIL", "legacy-owner@example.test")
    monkeypatch.setenv("TASKLUTEIN_LEGACY_TASKS_CONFIRM", "assign-existing-tasks")
    command.upgrade(alembic_config(), "head")
    command.check(alembic_config())

    with create_engine(postgres_database).connect() as connection:
        task = connection.execute(
            text("SELECT id, title, description, status, workspace_id FROM tasks WHERE id = :id"),
            {"id": str(task_id)},
        ).one()
        report = connection.execute(
            text("SELECT id, task_id, content, source, actor_user_id, agent_token_id FROM reports WHERE id = :id"),
            {"id": str(report_id)},
        ).one()
        counts = connection.execute(text("SELECT (SELECT count(*) FROM tasks), (SELECT count(*) FROM reports)")).one()
        workspace_not_null = connection.execute(
            text("SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() "
                 "AND table_name = 'tasks' AND column_name = 'workspace_id'")
        ).scalar_one()

    assert str(task.id) == str(task_id)
    assert (task.title, task.description, task.status) == ("Legacy task", "Keep this description", "in_progress")
    assert str(task.workspace_id) == owner["workspace"]["id"]
    assert str(report.id) == str(report_id)
    assert str(report.task_id) == str(task_id)
    assert (report.content, report.source) == ("Legacy report", "agent")
    assert report.actor_user_id is None
    assert report.agent_token_id is None
    assert counts == (1, 1)
    assert workspace_not_null == "NO"

    with TestClient(app) as client:
        visible = client.get("/api/tasks", headers=owner_headers)
        assert visible.status_code == 200
        assert [item["id"] for item in visible.json()["tasks"]] == [str(task_id)]
        legacy_reports = client.get(f"/api/tasks/{task_id}/reports", headers=owner_headers)
        assert legacy_reports.status_code == 200
        assert [item["id"] for item in legacy_reports.json()["reports"]] == [str(report_id)]


def test_concurrent_first_login_creates_one_user_and_workspace(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    headers = user_headers("concurrent-subject", "concurrent@example.test")

    def bootstrap_once() -> dict:
        with TestClient(app) as client:
            response = client.post("/api/session/bootstrap", headers=headers)
            assert response.status_code == 200, response.text
            return response.json()

    with ThreadPoolExecutor(max_workers=8) as executor:
        sessions = list(executor.map(lambda _index: bootstrap_once(), range(16)))

    user_ids = {session["user"]["id"] for session in sessions}
    workspace_ids = {session["workspace"]["id"] for session in sessions}
    assert len(user_ids) == 1
    assert len(workspace_ids) == 1

    with create_engine(postgres_database).connect() as connection:
        users = connection.scalar(
            text("SELECT count(*) FROM users WHERE access_issuer = :issuer AND access_subject = :subject"),
            {"issuer": ACCESS_ISSUER, "subject": "concurrent-subject"},
        )
        workspaces = connection.scalar(
            text("SELECT count(*) FROM workspaces WHERE owner_id = :user_id"),
            {"user_id": next(iter(user_ids))},
        )
    assert users == 1
    assert workspaces == 1


def test_migration_refuses_downgrade_to_shared_workspace_schema(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with pytest.raises(RuntimeError, match="cannot be downgraded to shared-workspace access"):
        command.downgrade(alembic_config(), "0001_baseline")
    with create_engine(postgres_database).connect() as connection:
        revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
    assert revision == "0003_task_workspace_required"


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
            response = client.get(
                "/api/ready",
                headers=user_headers("timeout-user", "timeout-user@example.test"),
            )
        elapsed = perf_counter() - started
        assert response.status_code == 503
        assert response.json()["code"] == "database_unavailable"
        assert elapsed < 5
    finally:
        app.dependency_overrides.clear()
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
