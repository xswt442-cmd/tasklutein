"""Migration and API integration checks against a disposable PostgreSQL database."""
import os
import socketserver
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from time import perf_counter, sleep
from uuid import uuid4

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from app.database import get_session_factory
from app.main import app
from app.models import AgentToken
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
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
        for table in (
            "activities", "report_comments", "reports", "agent_tokens", "tasks", "workspaces", "users",
            "alembic_version",
        ):
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


def test_agent_token_workspace_fk_name_matches_postgres_migration(postgres_database: str):
    command.upgrade(alembic_config(), "head")

    with create_engine(postgres_database).connect() as connection:
        workspace_fk = next(
            foreign_key
            for foreign_key in inspect(connection).get_foreign_keys("agent_tokens")
            if foreign_key["constrained_columns"] == ["workspace_id"]
        )
    model_fk = next(
        foreign_key
        for foreign_key in AgentToken.__table__.foreign_key_constraints
        if foreign_key.column_keys == ["workspace_id"]
    )

    assert workspace_fk["name"] == "agent_tokens_workspace_id_fkey"
    assert model_fk.name == workspace_fk["name"]
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
        legacy_activities = connection.scalar(
            text("SELECT count(*) FROM activities WHERE task_id = :task_id"), {"task_id": str(task_id)}
        )
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
    assert legacy_activities == 0
    assert workspace_not_null == "NO"

    with TestClient(app) as client:
        visible = client.get("/api/tasks", headers=owner_headers)
        assert visible.status_code == 200
        assert [item["id"] for item in visible.json()["tasks"]] == [str(task_id)]
        legacy_reports = client.get(f"/api/tasks/{task_id}/reports", headers=owner_headers)
        assert legacy_reports.status_code == 200
        assert [item["id"] for item in legacy_reports.json()["reports"]] == [str(report_id)]
        assert legacy_reports.json()["reports"][0]["actor_name"] is None
        legacy_history = client.get("/api/activity", headers=owner_headers, params={"task_id": str(task_id)})
        assert legacy_history.status_code == 200
        assert legacy_history.json()["total"] == 0


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


def test_migration_refuses_downgrade_from_report_comment_schema(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with pytest.raises(RuntimeError, match="Report comments cannot be removed"):
        command.downgrade(alembic_config(), "0001_baseline")
    with create_engine(postgres_database).connect() as connection:
        revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
    assert revision == "0006_agent_token_hard_delete"


def test_report_comments_migration_keeps_existing_reports_and_indexes(postgres_database: str):
    command.upgrade(alembic_config(), "0004_task_history")
    with TestClient(app) as client:
        headers, _identity = _new_identity(client, "comment-migration")
        task = _create_task(client, headers)
        report = _create_report(client, headers, task["id"])

    command.upgrade(alembic_config(), "head")
    with create_engine(postgres_database).connect() as connection:
        revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
        preserved = connection.execute(
            text("SELECT id, content FROM reports WHERE id = :report_id"),
            {"report_id": report["id"]},
        ).one()
        comments = inspect(connection)
        report_fk = next(
            foreign_key
            for foreign_key in comments.get_foreign_keys("report_comments")
            if foreign_key["constrained_columns"] == ["report_id"]
        )
        report_agent_fk = next(
            foreign_key
            for foreign_key in comments.get_foreign_keys("reports")
            if foreign_key["constrained_columns"] == ["agent_token_id"]
        )
        comment_agent_fk = next(
            foreign_key
            for foreign_key in comments.get_foreign_keys("report_comments")
            if foreign_key["constrained_columns"] == ["agent_token_id"]
        )
        indexes = comments.get_indexes("report_comments")

    assert revision == "0006_agent_token_hard_delete"
    assert (str(preserved.id), preserved.content) == (report["id"], report["content"])
    assert report_fk["referred_table"] == "reports"
    assert report_fk["options"]["ondelete"] == "CASCADE"
    assert report_agent_fk["options"]["ondelete"] == "SET NULL"
    assert comment_agent_fk["options"]["ondelete"] == "SET NULL"
    assert any(
        index["name"] == "idx_report_comments_report_created"
        and index["column_names"] == ["report_id", "created_at", "id"]
        for index in indexes
    )
    command.check(alembic_config())


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


def test_postgres_agent_key_metadata_updates_and_delete_remove_record(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        owner_headers, _owner = _new_identity(client, "agent-key-owner")
        other_headers, _other = _new_identity(client, "agent-key-other")
        secret, token_id = issue_agent_key(client, owner_headers, "Before edit")
        listed = client.get("/api/agent-tokens", headers=owner_headers)
        assert listed.status_code == 200, listed.text
        metadata = next(token for token in listed.json()["tokens"] if token["id"] == token_id)
        assert metadata["prefix"] == secret[:7]
        assert "secret" not in metadata and "token_hash" not in metadata

        expires_at = (datetime.now(UTC) + timedelta(days=3)).isoformat()
        updated = client.patch(
            f"/api/agent-tokens/{token_id}",
            headers=owner_headers,
            json={"name": "After edit", "expires_at": expires_at},
        )
        assert updated.status_code == 200, updated.text
        updated_metadata = updated.json()["token"]
        assert updated_metadata["name"] == "After edit"
        assert updated_metadata["prefix"] == secret[:7]
        assert "secret" not in updated_metadata and "token_hash" not in updated_metadata

        assert client.patch(
            f"/api/agent-tokens/{token_id}",
            headers=other_headers,
            json={"name": "Cross-workspace edit"},
        ).status_code == 404
        assert client.patch(
            f"/api/agent-tokens/{token_id}",
            headers=agent_headers(secret),
            json={"name": "Agent edit"},
        ).status_code == 403

        assert client.delete(f"/api/agent-tokens/{token_id}", headers=other_headers).status_code == 404
        deleted = client.delete(f"/api/agent-tokens/{token_id}", headers=owner_headers)
        assert deleted.status_code == 204
        assert client.delete(f"/api/agent-tokens/{token_id}", headers=owner_headers).status_code == 404
        final_tokens = client.get("/api/agent-tokens", headers=owner_headers).json()["tokens"]
        assert final_tokens == []
        assert client.patch(
            f"/api/agent-tokens/{token_id}",
            headers=owner_headers,
            json={"name": "After delete"},
        ).status_code == 404
        assert client.get("/api/agent/whoami", headers=agent_headers(secret)).status_code == 401


def test_postgres_agent_key_delete_preserves_history_and_removes_key_data(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        owner_headers, owner = _new_identity(client, "agent-key-delete-history")
        secret, token_id = issue_agent_key(client, owner_headers, "Delete with history")
        agent = agent_headers(secret)
        task = _create_task(client, owner_headers)
        agent_report = client.post(
            f"/api/tasks/{task['id']}/reports", headers=agent, json={"content": "Keep this report"}
        )
        assert agent_report.status_code == 201, agent_report.text
        report_id = agent_report.json()["report"]["id"]
        comment = client.post(
            f"/api/reports/{report_id}/comments", headers=agent, json={"content": "Keep this comment"}
        )
        assert comment.status_code == 201, comment.text
        comment_id = comment.json()["comment"]["id"]

        assert client.delete(f"/api/agent-tokens/{token_id}", headers=owner_headers).status_code == 204
        assert client.get("/api/agent-tokens", headers=owner_headers).json()["tokens"] == []
        assert client.get("/api/agent/whoami", headers=agent).status_code == 401
        reports = client.get(f"/api/tasks/{task['id']}/reports", headers=owner_headers).json()["reports"]
        assert reports[0]["id"] == report_id
        assert reports[0]["content"] == "Keep this report"
        assert reports[0]["actor_name"] is None
        comments = client.get(f"/api/reports/{report_id}/comments", headers=owner_headers).json()["comments"]
        assert comments[0]["id"] == comment_id
        assert comments[0]["content"] == "Keep this comment"
        assert comments[0]["actor_name"] is None

    with create_engine(postgres_database).connect() as connection:
        token_count = connection.scalar(text("SELECT count(*) FROM agent_tokens WHERE id = :id"), {"id": token_id})
        token_hash_count = connection.scalar(
            text("SELECT count(*) FROM agent_tokens WHERE token_hash = :hash"),
            {"hash": sha256(secret.encode("utf-8")).hexdigest()},
        )
        report_refs = connection.execute(
            text("SELECT agent_token_id, actor_user_id FROM reports WHERE id = :id"), {"id": report_id}
        ).one()
        comment_refs = connection.execute(
            text("SELECT agent_token_id, actor_user_id FROM report_comments WHERE id = :id"), {"id": comment_id}
        ).one()
        activity_refs = connection.execute(
            text("SELECT agent_token_id FROM activities WHERE event_type = 'report.created' AND task_id = :id"),
            {"id": task["id"]},
        ).one()
    assert token_count == 0
    assert token_hash_count == 0
    assert report_refs.agent_token_id is None
    assert str(report_refs.actor_user_id) == owner["user"]["id"]
    assert comment_refs.agent_token_id is None
    assert str(comment_refs.actor_user_id) == owner["user"]["id"]
    assert activity_refs.agent_token_id is None


def _new_identity(client: TestClient, label: str) -> tuple[dict[str, str], dict]:
    identity = uuid4().hex
    subject = f"{label}-{identity}"
    email = f"{label}-{identity}@example.test"
    return user_headers(subject, email), bootstrap(client, subject, email)


def _create_task(client: TestClient, headers: dict[str, str]) -> dict:
    response = client.post(
        "/api/tasks",
        headers=headers,
        json={"title": f"Task {uuid4().hex}", "description": f"Description {uuid4().hex}"},
    )
    assert response.status_code == 201, response.text
    return response.json()["task"]


def _create_report(client: TestClient, headers: dict[str, str], task_id: str) -> dict:
    content = f"Report {uuid4().hex}"
    response = client.post(f"/api/tasks/{task_id}/reports", headers=headers, json={"content": content})
    assert response.status_code == 201, response.text
    return response.json()["report"]


def _activity_page(client: TestClient, headers: dict[str, str], task_id: str) -> dict:
    response = client.get("/api/activity", headers=headers, params={"task_id": task_id, "limit": 100})
    assert response.status_code == 200, response.text
    return response.json()


def _task_counts(database_url: str, task_id: str) -> tuple[int, int, int]:
    with create_engine(database_url).connect() as connection:
        return connection.execute(
            text(
                "SELECT (SELECT count(*) FROM tasks WHERE id = :task_id), "
                "(SELECT count(*) FROM reports WHERE task_id = :task_id), "
                "(SELECT count(*) FROM activities WHERE task_id = :task_id)"
            ),
            {"task_id": task_id},
        ).one()


def test_postgres_task_report_and_archive_events_have_exact_semantics(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        headers, _identity = _new_identity(client, "event-contract")
        created = client.post(
            "/api/tasks",
            headers=headers,
            json={"title": f"Created {uuid4().hex}", "description": f"Private description {uuid4().hex}"},
        )
        assert created.status_code == 201, created.text
        task = created.json()["task"]
        task_id = task["id"]
        events = _activity_page(client, headers, task_id)
        assert events["total"] == 1
        created_event = events["activities"][0]
        assert created_event["event_type"] == "task.created"
        assert created_event["actor_type"] == "user"
        assert created_event["request_id"] == created.headers["X-Request-ID"]
        assert task["description"] not in str(created_event["summary"])

        no_op = client.patch(
            f"/api/tasks/{task_id}",
            headers=headers,
            json={"title": task["title"], "description": task["description"], "status": task["status"]},
        )
        assert no_op.status_code == 200, no_op.text
        assert no_op.json()["task"]["updated_at"] == task["updated_at"]
        assert _activity_page(client, headers, task_id)["total"] == 1

        updated = client.patch(f"/api/tasks/{task_id}", headers=headers, json={"title": f"Updated {uuid4().hex}"})
        assert updated.status_code == 200, updated.text
        updated_event = next(
            event for event in _activity_page(client, headers, task_id)["activities"]
            if event["event_type"] == "task.updated"
        )
        assert updated_event["request_id"] == updated.headers["X-Request-ID"]
        assert updated_event["summary"] == {"changed_fields": ["title"]}

        status_changed = client.patch(
            f"/api/tasks/{task_id}", headers=headers, json={"status": "in_progress"}
        )
        assert status_changed.status_code == 200, status_changed.text
        status_event = next(
            event for event in _activity_page(client, headers, task_id)["activities"]
            if event["event_type"] == "task.status_changed"
        )
        assert status_event["request_id"] == status_changed.headers["X-Request-ID"]
        assert status_event["summary"] == {
            "changed_fields": ["status"], "status_before": "todo", "status_after": "in_progress"
        }

        report_content = f"Private report content {uuid4().hex}"
        report_response = client.post(
            f"/api/tasks/{task_id}/reports", headers=headers, json={"content": report_content}
        )
        assert report_response.status_code == 201, report_response.text
        assert report_response.json()["report"]["actor_name"] == headers["X-Tasklutein-Access-Email"]
        report = report_response.json()["report"]
        current = client.get(f"/api/tasks/{task_id}", headers=headers)
        assert current.status_code == 200
        assert current.json()["task"]["updated_at"] == status_changed.json()["task"]["updated_at"]

        archived = client.delete(f"/api/tasks/{task_id}", headers=headers, params={"history": "keep"})
        assert archived.status_code == 204, archived.text
        all_events = _activity_page(client, headers, task_id)["activities"]
        assert len(all_events) == 5
        assert {event["event_type"] for event in all_events} == {
            "task.created", "task.updated", "task.status_changed", "report.created", "task.deleted"
        }
        report_event = next(event for event in all_events if event["event_type"] == "report.created")
        assert report_event["request_id"] == report_response.headers["X-Request-ID"]
        assert report_event["summary"] == {"report_id": report["id"]}
        assert report_content not in str(all_events)
        deleted_event = next(event for event in all_events if event["event_type"] == "task.deleted")
        assert deleted_event["request_id"] == archived.headers["X-Request-ID"]
        assert deleted_event["actor_type"] == "user"


def test_postgres_archive_preserves_full_task_and_report_snapshot(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        headers, _identity = _new_identity(client, "archive-snapshot")
        task = _create_task(client, headers)
        task_id = task["id"]
        changed = client.patch(
            f"/api/tasks/{task_id}",
            headers=headers,
            json={"title": f"Final {uuid4().hex}", "description": f"Final description {uuid4().hex}", "status": "done"},
        )
        assert changed.status_code == 200, changed.text
        expected_task = changed.json()["task"]
        reports_before = [_create_report(client, headers, task_id) for _ in range(3)]
        archived = client.delete(f"/api/tasks/{task_id}", headers=headers, params={"history": "keep"})
        assert archived.status_code == 204, archived.text

        for response in (
            client.get(f"/api/tasks/{task_id}", headers=headers),
            client.patch(f"/api/tasks/{task_id}", headers=headers, json={"status": "todo"}),
            client.get(f"/api/tasks/{task_id}/reports", headers=headers),
            client.post(f"/api/tasks/{task_id}/reports", headers=headers, json={"content": f"late {uuid4().hex}"}),
        ):
            assert response.status_code == 404, response.text

        detail = client.get(f"/api/history/tasks/{task_id}", headers=headers)
        assert detail.status_code == 200, detail.text
        archived_task = detail.json()["task"]
        for field in ("id", "title", "description", "status", "created_at", "updated_at"):
            assert archived_task[field] == expected_task[field]

        reports_after = []
        for offset in range(3):
            page = client.get(
                f"/api/history/tasks/{task_id}/reports", headers=headers, params={"limit": 1, "offset": offset}
            )
            assert page.status_code == 200, page.text
            assert page.json()["total"] == 3
            reports_after.extend(page.json()["reports"])
        expected_reports = {(r["id"], r["task_id"], r["content"]) for r in reports_before}
        assert {(r["id"], r["task_id"], r["content"]) for r in reports_after} == expected_reports

        with create_engine(postgres_database).connect() as connection:
            archived_at = connection.scalar(text("SELECT archived_at FROM tasks WHERE id = :id"), {"id": task_id})
            persisted_reports = connection.execute(
                text("SELECT id, task_id, content FROM reports WHERE task_id = :id"), {"id": task_id}
            ).all()
        assert archived_at is not None and archived_at.utcoffset() is not None
        assert {(str(r.id), str(r.task_id), r.content) for r in persisted_reports} == expected_reports


def test_postgres_history_cleanup_and_physical_delete_have_distinct_semantics(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        headers, _identity = _new_identity(client, "cleanup-contract")

        current = _create_task(client, headers)
        current_id = current["id"]
        _create_report(client, headers, current_id)
        assert _task_counts(postgres_database, current_id) == (1, 1, 2)
        cleared_current = client.delete(f"/api/history/tasks/{current_id}", headers=headers)
        assert cleared_current.status_code == 204, cleared_current.text
        current_after_cleanup = client.get(f"/api/tasks/{current_id}", headers=headers)
        assert current_after_cleanup.status_code == 200
        assert current_after_cleanup.json()["task"] == current
        assert _task_counts(postgres_database, current_id) == (1, 0, 0)
        assert client.get(f"/api/tasks/{current_id}/reports", headers=headers).json()["total"] == 0

        archived = _create_task(client, headers)
        archived_id = archived["id"]
        _create_report(client, headers, archived_id)
        deleted = client.delete(f"/api/tasks/{archived_id}", headers=headers, params={"history": "keep"})
        assert deleted.status_code == 204, deleted.text
        assert _task_counts(postgres_database, archived_id) == (1, 1, 3)
        cleared_archived = client.delete(f"/api/history/tasks/{archived_id}", headers=headers)
        assert cleared_archived.status_code == 204, cleared_archived.text
        assert _task_counts(postgres_database, archived_id) == (0, 0, 0)
        assert client.get(f"/api/tasks/{archived_id}", headers=headers).status_code == 404
        assert client.get(f"/api/history/tasks/{archived_id}", headers=headers).status_code == 404
        assert client.get(f"/api/history/tasks/{archived_id}/reports", headers=headers).status_code == 404

        physical = _create_task(client, headers)
        physical_id = physical["id"]
        _create_report(client, headers, physical_id)
        physically_deleted = client.delete(
            f"/api/tasks/{physical_id}", headers=headers, params={"history": "delete"}
        )
        assert physically_deleted.status_code == 204, physically_deleted.text
        assert _task_counts(postgres_database, physical_id) == (0, 0, 0)
        assert client.get("/api/activity", headers=headers, params={"task_id": physical_id}).json()["total"] == 0


def test_postgres_activity_deletion_and_history_reads_are_workspace_scoped(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        alice_headers, _alice = _new_identity(client, "history-owner")
        bob_headers, _bob = _new_identity(client, "history-outsider")
        task = _create_task(client, alice_headers)
        task_id = task["id"]
        report = _create_report(client, alice_headers, task_id)
        active_owner_events = _activity_page(client, alice_headers, task_id)
        assert active_owner_events["total"] == 2
        report_event_id = next(
            event["id"] for event in active_owner_events["activities"] if event["event_type"] == "report.created"
        )
        assert client.get("/api/activity", headers=bob_headers).json()["total"] == 0
        assert client.get(f"/api/tasks/{task_id}", headers=bob_headers).status_code == 404
        assert client.patch(f"/api/tasks/{task_id}", headers=bob_headers, json={"status": "done"}).status_code == 404
        assert client.get(f"/api/tasks/{task_id}/reports", headers=bob_headers).status_code == 404
        assert client.delete(f"/api/activity/{report_event_id}", headers=bob_headers).status_code == 404
        assert client.delete(f"/api/history/tasks/{task_id}", headers=bob_headers).status_code == 404
        assert client.delete(
            f"/api/tasks/{task_id}", headers=bob_headers, params={"history": "delete"}
        ).status_code == 404
        archived = client.delete(f"/api/tasks/{task_id}", headers=alice_headers, params={"history": "keep"})
        assert archived.status_code == 204, archived.text

        owner_activity = _activity_page(client, alice_headers, task_id)
        assert owner_activity["total"] == 3
        report_event_id = next(
            event["id"] for event in owner_activity["activities"] if event["event_type"] == "report.created"
        )
        assert client.get("/api/activity", headers=bob_headers).json()["total"] == 0
        assert client.get(f"/api/tasks/{task_id}", headers=bob_headers).status_code == 404
        assert client.patch(f"/api/tasks/{task_id}", headers=bob_headers, json={"status": "done"}).status_code == 404
        assert client.get(f"/api/tasks/{task_id}/reports", headers=bob_headers).status_code == 404
        assert client.get(f"/api/history/tasks/{task_id}", headers=bob_headers).status_code == 404
        assert client.get(f"/api/history/tasks/{task_id}/reports", headers=bob_headers).status_code == 404
        assert client.delete(f"/api/activity/{report_event_id}", headers=bob_headers).status_code == 404
        assert client.delete(f"/api/history/tasks/{task_id}", headers=bob_headers).status_code == 404
        assert client.delete(
            f"/api/tasks/{task_id}", headers=bob_headers, params={"history": "delete"}
        ).status_code == 404
        assert _activity_page(client, alice_headers, task_id)["total"] == 3

        removed = client.delete(f"/api/activity/{report_event_id}", headers=alice_headers)
        assert removed.status_code == 204, removed.text
        remaining = _activity_page(client, alice_headers, task_id)
        assert remaining["total"] == 2
        assert report_event_id not in {event["id"] for event in remaining["activities"]}
        archived_reports = client.get(f"/api/history/tasks/{task_id}/reports", headers=alice_headers)
        assert archived_reports.status_code == 200
        assert [item["id"] for item in archived_reports.json()["reports"]] == [report["id"]]
        assert _task_counts(postgres_database, task_id) == (1, 1, 2)


def test_postgres_activity_insert_failure_rolls_back_task_update(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app, raise_server_exceptions=False) as client:
        headers, _identity = _new_identity(client, "activity-failure")
        task = _create_task(client, headers)
        task_id = task["id"]
        trigger_suffix = uuid4().hex
        function_name = f"reject_task_update_activity_{trigger_suffix}"
        trigger_name = f"reject_task_update_activity_{trigger_suffix}"
        with create_engine(postgres_database).begin() as connection:
            connection.execute(
                text(
                    f"CREATE FUNCTION {function_name}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                    "BEGIN IF NEW.event_type = 'task.updated' THEN RAISE EXCEPTION 'forced activity failure'; "
                    "END IF; RETURN NEW; END $$"
                )
            )
            connection.execute(
                text(
                    f"CREATE TRIGGER {trigger_name} BEFORE INSERT ON activities "
                    f"FOR EACH ROW EXECUTE FUNCTION {function_name}()"
                )
            )
        try:
            failed = client.patch(
                f"/api/tasks/{task_id}", headers=headers, json={"title": f"Rollback {uuid4().hex}"}
            )
            assert failed.status_code == 500
        finally:
            with create_engine(postgres_database).begin() as connection:
                connection.execute(text(f"DROP TRIGGER IF EXISTS {trigger_name} ON activities"))
                connection.execute(text(f"DROP FUNCTION IF EXISTS {function_name}()"))

        after_failure = client.get(f"/api/tasks/{task_id}", headers=headers)
        assert after_failure.status_code == 200
        assert after_failure.json()["task"] == task
        assert _activity_page(client, headers, task_id)["total"] == 1


def test_postgres_concurrent_report_and_archive_leave_consistent_history(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        headers, _identity = _new_identity(client, "archive-race")
        task = _create_task(client, headers)
        task_id = task["id"]
        existing_report = _create_report(client, headers, task_id)

    barrier = threading.Barrier(2)
    racing_content = f"Racing report {uuid4().hex}"

    def create_racing_report():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.post(
                f"/api/tasks/{task_id}/reports", headers=headers, json={"content": racing_content}
            )

    def archive_task():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.delete(f"/api/tasks/{task_id}", headers=headers, params={"history": "keep"})

    with ThreadPoolExecutor(max_workers=2) as executor:
        report_future = executor.submit(create_racing_report)
        archive_future = executor.submit(archive_task)
        report_response = report_future.result(timeout=30)
        archive_response = archive_future.result(timeout=30)

    assert archive_response.status_code == 204, archive_response.text
    assert report_response.status_code in {201, 404}, report_response.text
    with TestClient(app) as client:
        reports = client.get(f"/api/history/tasks/{task_id}/reports", headers=headers)
        assert reports.status_code == 200, reports.text
        assert reports.json()["total"] == (2 if report_response.status_code == 201 else 1)
        contents = {item["content"] for item in reports.json()["reports"]}
        expected_contents = {existing_report["content"]}
        if report_response.status_code == 201:
            expected_contents.add(racing_content)
        assert contents == expected_contents
        event_types = [event["event_type"] for event in _activity_page(client, headers, task_id)["activities"]]
        assert event_types.count("task.deleted") == 1
        assert event_types.count("report.created") == (2 if report_response.status_code == 201 else 1)
        assert client.get(f"/api/tasks/{task_id}", headers=headers).status_code == 404

    with create_engine(postgres_database).connect() as connection:
        orphan_reports = connection.scalar(
            text("SELECT count(*) FROM reports r LEFT JOIN tasks t ON t.id = r.task_id WHERE t.id IS NULL")
        )
        orphan_activities = connection.scalar(
            text(
                "SELECT count(*) FROM activities a LEFT JOIN tasks t ON t.id = a.task_id "
                "WHERE t.id IS NULL OR a.workspace_id <> t.workspace_id"
            )
        )
    assert orphan_reports == 0
    assert orphan_activities == 0


def test_postgres_concurrent_task_update_and_archive_freeze_one_consistent_snapshot(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        headers, _identity = _new_identity(client, "update-archive-race")
        task = _create_task(client, headers)
        task_id = task["id"]

    barrier = threading.Barrier(2)

    def update_task():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.patch(f"/api/tasks/{task_id}", headers=headers, json={"status": "done"})

    def archive_task():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.delete(f"/api/tasks/{task_id}", headers=headers, params={"history": "keep"})

    with ThreadPoolExecutor(max_workers=2) as executor:
        update_future = executor.submit(update_task)
        archive_future = executor.submit(archive_task)
        update_response = update_future.result(timeout=30)
        archive_response = archive_future.result(timeout=30)

    assert update_response.status_code in {200, 404}, update_response.text
    assert archive_response.status_code == 204, archive_response.text
    with TestClient(app) as client:
        snapshot = client.get(f"/api/history/tasks/{task_id}", headers=headers)
        assert snapshot.status_code == 200, snapshot.text
        expected_status = "done" if update_response.status_code == 200 else "todo"
        assert snapshot.json()["task"]["status"] == expected_status
        event_types = [event["event_type"] for event in _activity_page(client, headers, task_id)["activities"]]
        assert event_types.count("task.created") == 1
        assert event_types.count("task.deleted") == 1
        assert event_types.count("task.status_changed") == (1 if update_response.status_code == 200 else 0)
        assert client.get(f"/api/tasks/{task_id}", headers=headers).status_code == 404


def test_postgres_concurrent_report_and_physical_delete_remove_the_whole_group(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        headers, _identity = _new_identity(client, "physical-delete-race")
        task = _create_task(client, headers)
        task_id = task["id"]
        _create_report(client, headers, task_id)

    barrier = threading.Barrier(2)
    racing_content = f"Report racing physical delete {uuid4().hex}"

    def create_racing_report():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.post(
                f"/api/tasks/{task_id}/reports", headers=headers, json={"content": racing_content}
            )

    def delete_task_and_history():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.delete(
                f"/api/tasks/{task_id}", headers=headers, params={"history": "delete"}
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        report_future = executor.submit(create_racing_report)
        delete_future = executor.submit(delete_task_and_history)
        report_response = report_future.result(timeout=30)
        delete_response = delete_future.result(timeout=30)

    assert report_response.status_code in {201, 404}, report_response.text
    assert delete_response.status_code == 204, delete_response.text
    assert _task_counts(postgres_database, task_id) == (0, 0, 0)
    with TestClient(app) as client:
        assert client.get(f"/api/tasks/{task_id}", headers=headers).status_code == 404
        assert client.get(f"/api/history/tasks/{task_id}", headers=headers).status_code == 404
        assert client.get("/api/activity", headers=headers, params={"task_id": task_id}).json()["total"] == 0


def test_postgres_concurrent_report_and_current_history_cleanup_leave_no_orphans(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        headers, _identity = _new_identity(client, "cleanup-race")
        task = _create_task(client, headers)
        task_id = task["id"]
        _create_report(client, headers, task_id)

    barrier = threading.Barrier(2)
    racing_content = f"Report racing cleanup {uuid4().hex}"

    def create_racing_report():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.post(
                f"/api/tasks/{task_id}/reports", headers=headers, json={"content": racing_content}
            )

    def clear_history():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.delete(f"/api/history/tasks/{task_id}", headers=headers)

    with ThreadPoolExecutor(max_workers=2) as executor:
        report_future = executor.submit(create_racing_report)
        cleanup_future = executor.submit(clear_history)
        report_response = report_future.result(timeout=30)
        cleanup_response = cleanup_future.result(timeout=30)

    assert report_response.status_code == 201, report_response.text
    assert cleanup_response.status_code == 204, cleanup_response.text
    with TestClient(app) as client:
        assert client.get(f"/api/tasks/{task_id}", headers=headers).status_code == 200
        reports = client.get(f"/api/tasks/{task_id}/reports", headers=headers)
        assert reports.status_code == 200, reports.text
        report_ids = {report["id"] for report in reports.json()["reports"]}
        assert len(report_ids) in {0, 1}
        activities = _activity_page(client, headers, task_id)
        assert activities["total"] in {0, 1}
        assert all(event["event_type"] == "report.created" for event in activities["activities"])
        assert {event["summary"]["report_id"] for event in activities["activities"]} == report_ids
        if report_ids:
            assert reports.json()["reports"][0]["content"] == racing_content

    with create_engine(postgres_database).connect() as connection:
        orphan_reports = connection.scalar(
            text("SELECT count(*) FROM reports r LEFT JOIN tasks t ON t.id = r.task_id WHERE t.id IS NULL")
        )
        orphan_activities = connection.scalar(
            text(
                "SELECT count(*) FROM activities a LEFT JOIN tasks t ON t.id = a.task_id "
                "WHERE t.id IS NULL OR a.workspace_id <> t.workspace_id"
            )
        )
    assert orphan_reports == 0
    assert orphan_activities == 0


def test_postgres_report_comments_keep_principal_scope_and_cascade_with_reports(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        owner_headers, owner = _new_identity(client, "report-comments-owner")
        outsider_headers, _outsider = _new_identity(client, "report-comments-outsider")
        task = _create_task(client, owner_headers)
        report = _create_report(client, owner_headers, task["id"])
        comments_url = f"/api/reports/{report['id']}/comments"
        user_comment = client.post(comments_url, headers=owner_headers, json={"content": "Human review"})
        assert user_comment.status_code == 201, user_comment.text
        agent_secret, agent_id = issue_agent_key(client, owner_headers, "Postgres comments Agent")
        agent_comment = client.post(
            comments_url, headers=agent_headers(agent_secret), json={"content": "Agent review"}
        )
        assert agent_comment.status_code == 201, agent_comment.text
        agent_comment_id = agent_comment.json()["comment"]["id"]

        assert client.get(comments_url, headers=outsider_headers).status_code == 404
        assert client.post(comments_url, headers=outsider_headers, json={"content": "No access"}).status_code == 404
        assert client.delete(f"{comments_url}/{agent_comment_id}", headers=outsider_headers).status_code == 404
        assert client.delete(f"{comments_url}/{agent_comment_id}", headers=agent_headers(agent_secret)).status_code == 403

        archived = client.delete(f"/api/tasks/{task['id']}", headers=owner_headers, params={"history": "keep"})
        assert archived.status_code == 204, archived.text
        archived_comments = client.get(comments_url, headers=owner_headers)
        assert archived_comments.status_code == 200, archived_comments.text
        assert archived_comments.json()["total"] == 2
        assert client.post(comments_url, headers=owner_headers, json={"content": "Archived"}).status_code == 404
        assert client.delete(f"{comments_url}/{agent_comment_id}", headers=owner_headers).status_code == 404

        current = _create_task(client, owner_headers)
        current_report = _create_report(client, owner_headers, current["id"])
        current_comment = client.post(
            f"/api/reports/{current_report['id']}/comments",
            headers=owner_headers,
            json={"content": "Clear with current history"},
        )
        assert current_comment.status_code == 201, current_comment.text
        assert client.delete(f"/api/history/tasks/{current['id']}", headers=owner_headers).status_code == 204

        physical = _create_task(client, owner_headers)
        physical_report = _create_report(client, owner_headers, physical["id"])
        physical_comment = client.post(
            f"/api/reports/{physical_report['id']}/comments",
            headers=owner_headers,
            json={"content": "Delete with task"},
        )
        assert physical_comment.status_code == 201, physical_comment.text
        assert client.delete(
            f"/api/tasks/{physical['id']}", headers=owner_headers, params={"history": "delete"}
        ).status_code == 204

    with create_engine(postgres_database).connect() as connection:
        persisted = connection.execute(
            text(
                "SELECT source, actor_user_id, agent_token_id FROM report_comments WHERE id = :id"
            ),
            {"id": agent_comment_id},
        ).one()
        archived_task_id = task["id"]
        remaining_archived = connection.scalar(
            text("SELECT count(*) FROM report_comments WHERE report_id = :report_id"),
            {"report_id": report["id"]},
        )
        current_remaining = connection.scalar(
            text("SELECT count(*) FROM report_comments WHERE report_id = :report_id"),
            {"report_id": current_report["id"]},
        )
        physical_remaining = connection.scalar(
            text("SELECT count(*) FROM report_comments WHERE report_id = :report_id"),
            {"report_id": physical_report["id"]},
        )
        orphan_comments = connection.scalar(
            text(
                "SELECT count(*) FROM report_comments c LEFT JOIN reports r ON r.id = c.report_id "
                "WHERE r.id IS NULL"
            )
        )
    assert persisted.source == "agent"
    assert str(persisted.actor_user_id) == owner["user"]["id"]
    assert str(persisted.agent_token_id) == agent_id
    assert remaining_archived == 2
    assert current_remaining == 0
    assert physical_remaining == 0
    assert orphan_comments == 0
    with TestClient(app) as client:
        assert client.delete(f"/api/history/tasks/{archived_task_id}", headers=owner_headers).status_code == 204
    with create_engine(postgres_database).connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM report_comments")) == 0


def test_postgres_concurrent_report_comment_and_archive_leave_consistent_history(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        headers, _identity = _new_identity(client, "report-comment-archive-race")
        task = _create_task(client, headers)
        report = _create_report(client, headers, task["id"])

    barrier = threading.Barrier(2)

    def add_comment():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.post(
                f"/api/reports/{report['id']}/comments",
                headers=headers,
                json={"content": f"Comment racing archive {uuid4().hex}"},
            )

    def archive_task():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.delete(f"/api/tasks/{task['id']}", headers=headers, params={"history": "keep"})

    with ThreadPoolExecutor(max_workers=2) as executor:
        comment_future = executor.submit(add_comment)
        archive_future = executor.submit(archive_task)
        comment_response = comment_future.result(timeout=30)
        archive_response = archive_future.result(timeout=30)

    assert comment_response.status_code in {201, 404}, comment_response.text
    assert archive_response.status_code == 204, archive_response.text
    with TestClient(app) as client:
        comments = client.get(f"/api/reports/{report['id']}/comments", headers=headers)
        assert comments.status_code == 200, comments.text
        assert comments.json()["total"] == (1 if comment_response.status_code == 201 else 0)
    with create_engine(postgres_database).connect() as connection:
        orphan_comments = connection.scalar(
            text(
                "SELECT count(*) FROM report_comments c LEFT JOIN reports r ON r.id = c.report_id "
                "WHERE r.id IS NULL"
            )
        )
        task_is_archived = connection.scalar(
            text("SELECT archived_at IS NOT NULL FROM tasks WHERE id = :task_id"),
            {"task_id": task["id"]},
        )
    assert orphan_comments == 0
    assert task_is_archived is True


def test_postgres_concurrent_report_comment_and_current_history_cleanup_leave_no_orphans(postgres_database: str):
    command.upgrade(alembic_config(), "head")
    with TestClient(app) as client:
        headers, _identity = _new_identity(client, "report-comment-cleanup-race")
        task = _create_task(client, headers)
        report = _create_report(client, headers, task["id"])

    barrier = threading.Barrier(2)

    def add_comment():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.post(
                f"/api/reports/{report['id']}/comments",
                headers=headers,
                json={"content": f"Comment racing cleanup {uuid4().hex}"},
            )

    def clear_history():
        with TestClient(app) as client:
            barrier.wait(timeout=10)
            return client.delete(f"/api/history/tasks/{task['id']}", headers=headers)

    with ThreadPoolExecutor(max_workers=2) as executor:
        comment_future = executor.submit(add_comment)
        cleanup_future = executor.submit(clear_history)
        comment_response = comment_future.result(timeout=30)
        cleanup_response = cleanup_future.result(timeout=30)

    assert comment_response.status_code in {201, 404}, comment_response.text
    assert cleanup_response.status_code == 204, cleanup_response.text
    with TestClient(app) as client:
        assert client.get(f"/api/tasks/{task['id']}", headers=headers).status_code == 200
        assert client.get(f"/api/reports/{report['id']}/comments", headers=headers).status_code == 404
    with create_engine(postgres_database).connect() as connection:
        orphan_comments = connection.scalar(
            text(
                "SELECT count(*) FROM report_comments c LEFT JOIN reports r ON r.id = c.report_id "
                "WHERE r.id IS NULL"
            )
        )
        comment_count = connection.scalar(text("SELECT count(*) FROM report_comments"))
        report_count = connection.scalar(text("SELECT count(*) FROM reports WHERE task_id = :task_id"),
                                         {"task_id": task["id"]})
    assert orphan_comments == 0
    assert comment_count == 0
    assert report_count == 0
