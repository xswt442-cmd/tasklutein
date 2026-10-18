import io
from datetime import UTC, datetime
from uuid import UUID

from app.main import app, logger
from app.models import AgentToken, Report, User
from conftest import agent_headers, gateway_headers, issue_agent_key, user_headers
from fastapi.testclient import TestClient
from sqlalchemy import select


def test_health_and_auth(client: TestClient):
    assert client.get("/api/health", headers=gateway_headers()).json()["status"] == "ok"

    missing = client.get("/api/tasks", headers=gateway_headers())
    assert missing.status_code == 401
    invalid = client.get(
        "/api/tasks",
        headers={**user_headers(), "X-Tasklutein-Access-Subject": "unbootstrapped"},
    )
    assert invalid.status_code == 401

    assert client.get("/api/tasks", headers=user_headers()).json() == {
        "tasks": [], "total": 0, "limit": 200, "offset": 0
    }
    assert client.get("/api/tasks", headers=agent_headers("tlu_invalid")).status_code == 401
    assert client.get("/api/ready", headers=user_headers()).json() == {"status": "ready"}


def test_api_generates_request_ids_and_rejects_forged_origin_ids(client: TestClient):
    headers_with_invalid_id = {**user_headers(), "X-Request-ID": "caller-supplied"}
    response = client.get("/api/tasks", headers=headers_with_invalid_id)
    assert response.status_code == 200
    assert response.headers["X-Request-ID"] != "caller-supplied"
    assert response.json()["tasks"] == []

    response = client.get("/api/tasks", headers={**gateway_headers(), "X-Request-ID": "caller-supplied"})
    assert response.status_code == 401
    assert response.headers["X-Request-ID"] != "caller-supplied"


def test_request_completion_is_written_to_stderr(client: TestClient):
    handler = logger.handlers[0]
    original_stream = handler.stream
    capture = io.StringIO()
    handler.setStream(capture)
    try:
        response = client.get("/api/health", headers=gateway_headers())
    finally:
        handler.setStream(original_stream)
    assert response.status_code == 200

    output = capture.getvalue()
    events = [line for line in output.splitlines() if '"event":"request_complete"' in line]
    assert events
    assert '"request_id":"' + response.headers["X-Request-ID"] + '"' in events[-1]
    assert '"route":"/api/health"' in events[-1]
    assert '"status":200' in events[-1]


def test_api_errors_include_safe_codes_and_request_ids(client: TestClient):
    missing = client.get(
        "/api/tasks/00000000-0000-4000-8000-000000000001",
        headers=user_headers(),
    )
    assert missing.status_code == 404
    assert missing.json()["detail"] == "task_not_found"
    assert missing.json()["code"] == "task_not_found"
    assert missing.json()["request_id"] == missing.headers["X-Request-ID"]

    invalid = client.post(
        "/api/tasks",
        headers=user_headers(),
        json={"title": "Sensitive title that exceeds the allowed field length " + "x" * 120},
    )
    assert invalid.status_code == 422
    assert invalid.json()["code"] == "validation_error"
    assert invalid.json()["request_id"] == invalid.headers["X-Request-ID"]
    assert "input" not in str(invalid.json()["detail"])
    assert "Sensitive title" not in str(invalid.json())


def test_identity_validation_and_origin_csrf_rejection(client: TestClient):
    malformed_identity = {
        **user_headers(),
        "X-Tasklutein-Access-Email": "not-an-email",
    }
    assert client.get("/api/tasks", headers=malformed_identity).status_code == 401

    disallowed_origin = user_headers(origin="https://attacker.example")
    response = client.post("/api/tasks", headers=disallowed_origin, json={"title": "blocked"})
    assert response.status_code == 403
    assert response.json()["code"] == "origin_not_allowed"

    no_origin = user_headers()
    no_origin.pop("Origin")
    assert client.post("/api/tasks", headers=no_origin, json={"title": "blocked"}).status_code == 403


def test_workspace_isolation_and_scope_for_tasks_reports_and_overview(client: TestClient):
    other_identity = user_headers(subject="other-user", email="other@example.test")
    bootstrapped = client.post("/api/session/bootstrap", headers=other_identity)
    assert bootstrapped.status_code == 200

    own = client.post("/api/tasks", headers=user_headers(), json={"title": "Private task"})
    other = client.post("/api/tasks", headers=other_identity, json={"title": "Other task"})
    assert own.status_code == other.status_code == 201
    own_id = own.json()["task"]["id"]
    other_id = other.json()["task"]["id"]
    other_key = client.post(
        "/api/agent-tokens", headers=other_identity, json={"name": "Other workspace Agent"}
    )
    assert other_key.status_code == 201
    other_agent_headers = agent_headers(other_key.json()["secret"])

    own_report = client.post(
        f"/api/tasks/{own_id}/reports", headers=user_headers(), json={"content": "Private report"}
    )
    assert own_report.status_code == 201

    other_tasks = client.get("/api/tasks", headers=other_identity).json()
    assert [task["id"] for task in other_tasks["tasks"]] == [other_id]
    assert other_tasks["total"] == 1
    assert client.get(f"/api/tasks/{own_id}", headers=other_identity).status_code == 404
    assert client.get("/api/tasks", headers=other_agent_headers).json()["tasks"][0]["id"] == other_id
    assert client.get(f"/api/tasks/{own_id}", headers=other_agent_headers).status_code == 404
    assert client.patch(
        f"/api/tasks/{own_id}", headers=other_identity, json={"status": "done"}
    ).status_code == 404
    assert client.delete(f"/api/tasks/{own_id}", headers=other_identity).status_code == 404
    assert client.get(f"/api/tasks/{own_id}/reports", headers=other_identity).status_code == 404
    assert client.post(
        f"/api/tasks/{own_id}/reports", headers=other_identity, json={"content": "cross scope"}
    ).status_code == 404

    own_overview = client.get("/api/overview", headers=user_headers()).json()
    other_overview = client.get("/api/overview", headers=other_identity).json()
    assert own_overview["total"] == 1
    assert own_overview["by_status"] == {"todo": 1, "in_progress": 0, "done": 0}
    assert other_overview["total"] == 1

    assert client.get(f"/api/tasks/{other_id}", headers=user_headers()).status_code == 404


def test_task_search_pagination_and_overview_use_the_full_workspace(client: TestClient):
    first = client.post(
        "/api/tasks",
        headers=user_headers(),
        json={"title": "Plan 50%_Release", "description": "prepare the handoff"},
    )
    second = client.post("/api/tasks", headers=user_headers(), json={"title": "Release notes"})
    third = client.post(
        "/api/tasks",
        headers=user_headers(),
        json={"title": "Archive report", "status": "in_progress"},
    )
    assert [first.status_code, second.status_code, third.status_code] == [201, 201, 201]

    literal_search = client.get(
        "/api/tasks", headers=user_headers(), params={"q": "50%_release", "limit": 25}
    )
    assert literal_search.status_code == 200
    assert literal_search.json()["total"] == 1
    assert literal_search.json()["tasks"][0]["id"] == first.json()["task"]["id"]

    page_one = client.get(
        "/api/tasks", headers=user_headers(), params={"status": "todo", "limit": 1, "offset": 0}
    )
    page_two = client.get(
        "/api/tasks", headers=user_headers(), params={"status": "todo", "limit": 1, "offset": 1}
    )
    assert page_one.status_code == page_two.status_code == 200
    assert page_one.json()["total"] == page_two.json()["total"] == 2
    assert page_one.json()["limit"] == page_two.json()["limit"] == 1
    assert page_one.json()["offset"] == 0
    assert page_two.json()["offset"] == 1
    assert page_one.json()["tasks"][0]["id"] != page_two.json()["tasks"][0]["id"]

    overview = client.get("/api/overview", headers=user_headers())
    assert overview.status_code == 200
    assert overview.json()["total"] == 3
    assert overview.json()["by_status"] == {"todo": 2, "in_progress": 1, "done": 0}
    assert overview.json()["generated_at"].endswith("Z")

    assert client.get("/api/tasks?limit=0", headers=user_headers()).status_code == 422
    assert client.get("/api/tasks?sort=client_supplied_sql", headers=user_headers()).status_code == 422


def test_task_lifecycle_agent_keys_and_report_provenance(client: TestClient):
    first_secret = issue_agent_key(client, "CI Agent")
    second_secret = issue_agent_key(client, "Review Agent")
    first_whoami = client.get("/api/agent/whoami", headers=agent_headers(first_secret))
    second_whoami = client.get("/api/agent/whoami", headers=agent_headers(second_secret))
    assert first_whoami.status_code == second_whoami.status_code == 200
    assert first_whoami.json()["agent_token_id"] != second_whoami.json()["agent_token_id"]
    assert first_whoami.json()["workspace_id"] == second_whoami.json()["workspace_id"]

    created = client.post("/api/tasks", headers=user_headers(), json={"title": "  Ship feature  "})
    assert created.status_code == 201
    task = created.json()["task"]
    assert task["title"] == "Ship feature"
    assert task["status"] == "todo"

    task_id = task["id"]
    assert client.get("/api/tasks", headers=agent_headers(first_secret)).json()["tasks"][0]["id"] == task_id

    updated = client.patch(
        "/api/tasks/" + task_id,
        headers=agent_headers(first_secret),
        json={"status": "done"},
    )
    assert updated.status_code == 200
    assert updated.json()["task"]["status"] == "done"

    user_report = client.post(
        f"/api/tasks/{task_id}/reports", headers=user_headers(), json={"content": "Checked manually."}
    )
    agent_report = client.post(
        "/api/tasks/" + task_id + "/reports",
        headers=agent_headers(first_secret),
        json={"content": "Verified after running tests."},
    )
    assert user_report.status_code == agent_report.status_code == 201
    assert user_report.json()["report"]["source"] == "user"
    assert agent_report.json()["report"]["source"] == "agent"
    reports = client.get(f"/api/tasks/{task_id}/reports", headers=user_headers()).json()
    assert reports["total"] == 2
    assert {item["source"] for item in reports["reports"]} == {"user", "agent"}

    factory = app.state.test_session_factory
    with factory() as db:
        stored_reports = db.scalars(select(Report).where(Report.task_id == UUID(task["id"]))).all()
        agent_token = db.scalar(select(AgentToken).where(AgentToken.name == "CI Agent"))
        assert agent_token is not None
        stored_agent_report = next(report for report in stored_reports if report.source == "agent")
        stored_user_report = next(report for report in stored_reports if report.source == "user")
        assert stored_agent_report.agent_token_id == agent_token.id
        assert stored_agent_report.actor_user_id == agent_token.created_by
        assert stored_user_report.agent_token_id is None
        assert stored_user_report.actor_user_id == agent_token.created_by

    tokens = client.get("/api/agent-tokens", headers=user_headers()).json()["tokens"]
    ci_token = next(token for token in tokens if token["name"] == "CI Agent")
    revoked = client.delete(f"/api/agent-tokens/{ci_token['id']}", headers=user_headers())
    assert revoked.status_code == 204
    assert client.get("/api/agent/whoami", headers=agent_headers(first_secret)).status_code == 401
    assert client.get("/api/agent/whoami", headers=agent_headers(second_secret)).status_code == 200

    assert client.delete("/api/tasks/" + task_id, headers=user_headers()).status_code == 204
    assert client.get("/api/tasks/" + task_id, headers=user_headers()).status_code == 404
    assert client.get("/api/tasks/" + task_id + "/reports", headers=user_headers()).status_code == 404


def test_disabled_user_rejects_user_and_agent_credentials(client: TestClient):
    secret = issue_agent_key(client, "Disabled owner Agent")
    factory = app.state.test_session_factory
    with factory.begin() as db:
        user = db.scalar(select(User).where(User.access_subject == "local-test-user"))
        assert user is not None
        user.disabled_at = datetime.now(UTC)

    assert client.get("/api/tasks", headers=user_headers()).status_code == 403
    assert client.get("/api/tasks", headers=agent_headers(secret)).status_code == 403
    bootstrap = client.post("/api/session/bootstrap", headers=user_headers())
    assert bootstrap.status_code == 403
    assert bootstrap.json()["code"] == "user_disabled"


def test_validation(client: TestClient):
    assert client.post("/api/tasks", headers=user_headers(), json={"title": " "}).status_code == 422
    assert client.post("/api/tasks", headers=user_headers(), json={"title": "ok", "source": "agent"}).status_code == 422
    created = client.post("/api/tasks", headers=user_headers(), json={"title": "valid"})
    task_id = created.json()["task"]["id"]
    assert client.patch("/api/tasks/" + task_id, headers=user_headers(), json={}).status_code == 422
    assert client.post(
        "/api/tasks/" + task_id + "/reports",
        headers=user_headers(),
        json={"content": "report", "source": "agent"},
    ).status_code == 422
    assert client.get("/api/tasks", headers=user_headers(), params={"status": "unknown"}).status_code == 422
