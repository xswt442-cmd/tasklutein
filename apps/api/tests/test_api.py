import io
from datetime import UTC, datetime, timedelta
from uuid import UUID

from app.main import app, logger
from app.models import Activity, AgentToken, Report, ReportComment, User
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


def test_agent_key_metadata_exposes_only_the_short_display_prefix(client: TestClient):
    created = client.post("/api/agent-tokens", headers=user_headers(), json={"name": "Short display"})
    assert created.status_code == 201
    payload = created.json()
    expected_prefix = payload["secret"][:7]

    assert payload["token"]["prefix"] == expected_prefix
    assert "secret" not in payload["token"]
    assert "token_hash" not in payload["token"]
    listed = client.get("/api/agent-tokens", headers=user_headers()).json()["tokens"]
    assert listed == [payload["token"]]
    assert listed[0]["prefix"] == expected_prefix
    assert payload["secret"][7:] not in str(listed)


def test_agent_key_can_update_name_and_expiration(client: TestClient):
    created = client.post("/api/agent-tokens", headers=user_headers(), json={"name": "Before edit"})
    token_id = created.json()["token"]["id"]
    expiry = (datetime.now(UTC) + timedelta(days=2)).isoformat()

    updated = client.patch(
        f"/api/agent-tokens/{token_id}",
        headers=user_headers(),
        json={"name": "After edit", "expires_at": expiry},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["token"]["name"] == "After edit"
    returned_expiry = datetime.fromisoformat(updated.json()["token"]["expires_at"].replace("Z", "+00:00"))
    if returned_expiry.tzinfo is None:
        returned_expiry = returned_expiry.replace(tzinfo=UTC)
    assert returned_expiry == datetime.fromisoformat(expiry)
    assert updated.json()["token"]["prefix"] == created.json()["secret"][:7]
    assert "secret" not in updated.json()["token"]

    cleared_expiry = client.patch(
        f"/api/agent-tokens/{token_id}", headers=user_headers(), json={"expires_at": None}
    )
    assert cleared_expiry.status_code == 200, cleared_expiry.text
    assert cleared_expiry.json()["token"]["name"] == "After edit"
    assert cleared_expiry.json()["token"]["expires_at"] is None


def test_revoked_agent_key_stays_visible_but_cannot_be_updated(client: TestClient):
    created = client.post("/api/agent-tokens", headers=user_headers(), json={"name": "Keep revoked row"})
    token_id = created.json()["token"]["id"]
    other_headers = user_headers(subject="other-key-owner", email="other-key-owner@example.test")
    assert client.post("/api/session/bootstrap", headers=other_headers).status_code == 200

    assert client.patch(
        f"/api/agent-tokens/{token_id}", headers=other_headers, json={"name": "Cross-workspace"}
    ).status_code == 404
    assert client.patch(
        f"/api/agent-tokens/{token_id}",
        headers=agent_headers(created.json()["secret"]),
        json={"name": "Agent cannot edit"},
    ).status_code == 403

    revoked = client.delete(f"/api/agent-tokens/{token_id}", headers=user_headers())
    assert revoked.status_code == 204
    listed = client.get("/api/agent-tokens", headers=user_headers()).json()["tokens"]
    assert len(listed) == 1
    assert listed[0]["id"] == token_id
    assert listed[0]["name"] == "Keep revoked row"
    assert listed[0]["revoked_at"] is not None
    assert listed[0]["prefix"] == created.json()["secret"][:7]
    assert client.patch(
        f"/api/agent-tokens/{token_id}", headers=user_headers(), json={"name": "After revoke"}
    ).status_code == 409
    assert client.delete(f"/api/agent-tokens/{token_id}", headers=user_headers()).status_code == 204


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


def test_task_and_report_changes_create_scoped_activity_events(client: TestClient):
    created = client.post(
        "/api/tasks",
        headers=user_headers(),
        json={"title": "Activity test task", "description": "Do not copy this description into history."},
    )
    assert created.status_code == 201
    task = created.json()["task"]
    task_id = task["id"]

    created_events = client.get("/api/activity", headers=user_headers(), params={"task_id": task_id})
    assert created_events.status_code == 200
    assert created_events.json()["total"] == 1
    created_event = created_events.json()["activities"][0]
    assert created_event["event_type"] == "task.created"
    assert created_event["actor_type"] == "user"
    assert created_event["actor_name"] == "local-test@example.test"
    assert created_event["request_id"] == created.headers["X-Request-ID"]
    assert "Do not copy this description" not in str(created_event["summary"])

    unchanged = client.patch(
        f"/api/tasks/{task_id}",
        headers=user_headers(),
        json={"title": task["title"], "status": task["status"]},
    )
    assert unchanged.status_code == 200
    assert unchanged.json()["task"]["updated_at"] == task["updated_at"]
    assert client.get("/api/activity", headers=user_headers(), params={"task_id": task_id}).json()["total"] == 1

    changed = client.patch(
        f"/api/tasks/{task_id}",
        headers=user_headers(),
        json={"title": "Updated activity task", "status": "in_progress"},
    )
    assert changed.status_code == 200
    changed_event = client.get("/api/activity", headers=user_headers(), params={"task_id": task_id}).json()[
        "activities"
    ][0]
    assert changed_event["event_type"] == "task.status_changed"
    assert changed_event["request_id"] == changed.headers["X-Request-ID"]
    assert changed_event["summary"] == {
        "changed_fields": ["title", "status"],
        "status_before": "todo",
        "status_after": "in_progress",
    }

    report_content = "A report body must not be duplicated into activity history."
    report = client.post(
        f"/api/tasks/{task_id}/reports",
        headers=user_headers(),
        json={"content": report_content},
    )
    assert report.status_code == 201
    assert report.json()["report"]["actor_name"] == "local-test@example.test"
    listed_reports = client.get(f"/api/tasks/{task_id}/reports", headers=user_headers()).json()
    assert listed_reports["reports"][0]["actor_name"] == "local-test@example.test"
    current = client.get(f"/api/tasks/{task_id}", headers=user_headers()).json()["task"]
    assert current["updated_at"] == changed.json()["task"]["updated_at"]

    activity_page = client.get("/api/activity", headers=user_headers(), params={"task_id": task_id}).json()
    assert activity_page["total"] == 3
    report_event = activity_page["activities"][0]
    assert report_event["event_type"] == "report.created"
    assert report_event["actor_type"] == "user"
    assert report_event["actor_name"] == "local-test@example.test"
    assert report_event["request_id"] == report.headers["X-Request-ID"]
    assert report_event["summary"] == {"report_id": report.json()["report"]["id"]}
    assert report_content not in str(activity_page["activities"])


def test_agent_activity_identifies_the_verified_key(client: TestClient):
    secret = issue_agent_key(client, "History MCP Agent")
    created = client.post(
        "/api/tasks",
        headers=agent_headers(secret),
        json={"title": "Agent activity", "description": "Agent task description."},
    )
    assert created.status_code == 201
    task = created.json()["task"]
    activity = client.get(
        "/api/activity",
        headers=user_headers(),
        params={"source": "agent", "task_id": task["id"]},
    )
    assert activity.status_code == 200
    assert activity.json()["total"] == 1
    event = activity.json()["activities"][0]
    assert event["event_type"] == "task.created"
    assert event["actor_type"] == "agent"
    assert event["actor_name"] == "History MCP Agent"
    assert event["agent_token_id"] is not None
    assert event["actor_user_id"] is not None
    assert event["request_id"] == created.headers["X-Request-ID"]
    assert "Agent task description" not in str(event["summary"])
    assert client.get(
        "/api/activity",
        headers=user_headers(),
        params={"source": "user", "task_id": task["id"]},
    ).json()["total"] == 0

    report = client.post(
        f"/api/tasks/{task['id']}/reports",
        headers=agent_headers(secret),
        json={"content": "Report by a verified Agent key."},
    )
    assert report.status_code == 201
    assert report.json()["report"]["actor_name"] == "History MCP Agent"
    listed_report = client.get(f"/api/tasks/{task['id']}/reports", headers=user_headers()).json()["reports"][0]
    assert listed_report["actor_name"] == "History MCP Agent"


def test_history_actor_name_tracks_current_agent_key_name(client: TestClient):
    key = client.post("/api/agent-tokens", headers=user_headers(), json={"name": "Before rename"})
    assert key.status_code == 201, key.text
    token_id = UUID(key.json()["token"]["id"])
    secret = key.json()["secret"]

    task = client.post("/api/tasks", headers=user_headers(), json={"title": "Rename attribution"})
    assert task.status_code == 201, task.text
    task_id = task.json()["task"]["id"]
    report = client.post(
        f"/api/tasks/{task_id}/reports",
        headers=agent_headers(secret),
        json={"content": "Reported before the key rename."},
    )
    assert report.status_code == 201, report.text
    report_id = UUID(report.json()["report"]["id"])
    assert report.json()["report"]["actor_name"] == "Before rename"

    renamed = client.patch(
        f"/api/agent-tokens/{token_id}", headers=user_headers(), json={"name": "After rename"}
    )
    assert renamed.status_code == 200, renamed.text

    listed_report = client.get(f"/api/tasks/{task_id}/reports", headers=user_headers()).json()["reports"][0]
    assert listed_report["id"] == str(report_id)
    assert listed_report["source"] == "agent"
    assert listed_report["actor_name"] == "After rename"
    activities = client.get(
        "/api/activity", headers=user_headers(), params={"source": "agent", "task_id": task_id}
    ).json()["activities"]
    assert len(activities) == 1
    assert activities[0]["event_type"] == "report.created"
    assert activities[0]["agent_token_id"] == str(token_id)
    assert activities[0]["actor_name"] == "After rename"

    with app.state.test_session_factory() as db:
        stored_report = db.get(Report, report_id)
        stored_activity = db.scalar(
            select(Activity).where(
                Activity.task_id == UUID(task_id),
                Activity.event_type == "report.created",
            )
        )
        assert stored_report is not None and stored_report.agent_token_id == token_id
        assert stored_activity is not None and stored_activity.agent_token_id == token_id


def test_archiving_keeps_a_read_only_task_and_complete_report_snapshot(client: TestClient):
    created = client.post(
        "/api/tasks",
        headers=user_headers(),
        json={"title": "Archive snapshot", "description": "Complete task description."},
    )
    assert created.status_code == 201
    original = created.json()["task"]
    task_id = original["id"]
    report_content = "Complete report content for the archived task."
    report = client.post(
        f"/api/tasks/{task_id}/reports",
        headers=user_headers(),
        json={"content": report_content},
    )
    assert report.status_code == 201

    archived = client.delete(f"/api/tasks/{task_id}?history=keep", headers=user_headers())
    assert archived.status_code == 204
    assert client.get("/api/tasks", headers=user_headers()).json()["total"] == 0
    assert client.get("/api/overview", headers=user_headers()).json()["total"] == 0
    assert client.get(f"/api/tasks/{task_id}", headers=user_headers()).status_code == 404
    assert client.get(f"/api/tasks/{task_id}/reports", headers=user_headers()).status_code == 404
    assert client.patch(
        f"/api/tasks/{task_id}", headers=user_headers(), json={"status": "done"}
    ).status_code == 404
    assert client.post(
        f"/api/tasks/{task_id}/reports", headers=user_headers(), json={"content": "too late"}
    ).status_code == 404

    history = client.get(f"/api/history/tasks/{task_id}", headers=user_headers())
    assert history.status_code == 200
    archived_task = history.json()["task"]
    datetime.fromisoformat(archived_task["archived_at"].replace("Z", "+00:00"))
    assert {key: archived_task[key] for key in original} == original

    reports = client.get(f"/api/history/tasks/{task_id}/reports", headers=user_headers())
    assert reports.status_code == 200
    assert reports.json()["total"] == 1
    assert reports.json()["reports"] == [report.json()["report"]]

    activities = client.get("/api/activity", headers=user_headers(), params={"task_id": task_id})
    assert activities.status_code == 200
    assert activities.json()["total"] == 3
    assert {item["event_type"] for item in activities.json()["activities"]} == {
        "task.created", "report.created", "task.deleted"
    }
    serialized_activities = str(activities.json()["activities"])
    assert "Complete task description" not in serialized_activities
    assert report_content not in serialized_activities
    overview_activities = client.get("/api/overview", headers=user_headers()).json()["recent_activities"]
    assert {item["event_type"] for item in overview_activities} == {
        "task.created", "report.created", "task.deleted"
    }

    cleared = client.delete(f"/api/history/tasks/{task_id}", headers=user_headers())
    assert cleared.status_code == 204
    assert client.get(f"/api/history/tasks/{task_id}", headers=user_headers()).status_code == 404
    assert client.get(f"/api/history/tasks/{task_id}/reports", headers=user_headers()).status_code == 404
    assert client.get("/api/activity", headers=user_headers(), params={"task_id": task_id}).json()["total"] == 0


def test_report_comments_are_workspace_scoped_paginated_and_attributed(client: TestClient):
    task = client.post("/api/tasks", headers=user_headers(), json={"title": "Report comments"}).json()["task"]
    report = client.post(
        f"/api/tasks/{task['id']}/reports", headers=user_headers(), json={"content": "Implementation progress"}
    ).json()["report"]
    agent_name = "Commenting Agent"
    agent_token = client.post("/api/agent-tokens", headers=user_headers(), json={"name": agent_name})
    assert agent_token.status_code == 201, agent_token.text
    agent_secret = agent_token.json()["secret"]
    agent_token_id = agent_token.json()["token"]["id"]
    agent = agent_headers(agent_secret)
    comments_url = f"/api/reports/{report['id']}/comments"

    agent_comment = client.post(comments_url, headers=agent, json={"content": "I verified the API path."})
    user_comment = client.post(comments_url, headers=user_headers(), json={"content": "Thanks, I reviewed it."})
    assert agent_comment.status_code == 201, agent_comment.text
    assert user_comment.status_code == 201, user_comment.text
    assert agent_comment.json()["comment"] == {
        "id": agent_comment.json()["comment"]["id"],
        "report_id": report["id"],
        "content": "I verified the API path.",
        "source": "agent",
        "actor_name": agent_name,
        "created_at": agent_comment.json()["comment"]["created_at"],
    }
    assert user_comment.json()["comment"]["source"] == "user"
    assert user_comment.json()["comment"]["actor_name"] == "local-test@example.test"

    first_page = client.get(comments_url, headers=user_headers(), params={"limit": 1, "offset": 0})
    second_page = client.get(comments_url, headers=agent, params={"limit": 1, "offset": 1})
    assert first_page.status_code == second_page.status_code == 200
    assert first_page.json()["total"] == second_page.json()["total"] == 2
    assert first_page.json()["comments"][0]["id"] == agent_comment.json()["comment"]["id"]
    assert second_page.json()["comments"][0]["id"] == user_comment.json()["comment"]["id"]
    assert first_page.json()["comments"][0]["created_at"] <= second_page.json()["comments"][0]["created_at"]

    task_after_comments = client.get(f"/api/tasks/{task['id']}", headers=user_headers()).json()["task"]
    assert task_after_comments["updated_at"] == task["updated_at"]
    events = client.get("/api/activity", headers=user_headers(), params={"task_id": task["id"]}).json()
    assert events["total"] == 2
    assert {event["event_type"] for event in events["activities"]} == {"task.created", "report.created"}

    outsider = user_headers(subject="report-comment-outsider", email="report-comment-outsider@example.test")
    assert client.post("/api/session/bootstrap", headers=outsider).status_code == 200
    assert client.get(comments_url, headers=outsider).status_code == 404
    assert client.post(comments_url, headers=outsider, json={"content": "intrusion"}).status_code == 404
    assert client.delete(
        f"{comments_url}/{agent_comment.json()['comment']['id']}", headers=outsider
    ).status_code == 404
    assert client.delete(
        f"{comments_url}/{agent_comment.json()['comment']['id']}", headers=agent
    ).status_code == 403
    assert client.delete(f"/api/agent-tokens/{agent_token_id}", headers=user_headers()).status_code == 204
    assert client.post(comments_url, headers=agent, json={"content": "Revoked key"}).status_code == 401
    assert client.delete(
        f"{comments_url}/{agent_comment.json()['comment']['id']}", headers=user_headers()
    ).status_code == 204

    remaining = client.get(comments_url, headers=user_headers())
    assert remaining.status_code == 200
    assert remaining.json()["total"] == 1
    assert remaining.json()["comments"][0]["id"] == user_comment.json()["comment"]["id"]


def test_report_comments_validate_content_and_archived_reports_are_read_only(client: TestClient):
    task = client.post("/api/tasks", headers=user_headers(), json={"title": "Archived comments"}).json()["task"]
    report = client.post(
        f"/api/tasks/{task['id']}/reports", headers=user_headers(), json={"content": "Report before archive"}
    ).json()["report"]
    comments_url = f"/api/reports/{report['id']}/comments"

    assert client.post(comments_url, headers=user_headers(), json={"content": "  \n "}).status_code == 422
    assert client.post(comments_url, headers=user_headers(), json={"content": "x" * 2001}).status_code == 422
    assert client.post(
        comments_url, headers=user_headers(), json={"content": "comment", "source": "agent"}
    ).status_code == 422
    created = client.post(comments_url, headers=user_headers(), json={"content": "Keep with archive"})
    assert created.status_code == 201, created.text

    archived = client.delete(f"/api/tasks/{task['id']}", headers=user_headers(), params={"history": "keep"})
    assert archived.status_code == 204
    listed = client.get(comments_url, headers=user_headers())
    assert listed.status_code == 200
    assert listed.json()["comments"][0]["content"] == "Keep with archive"
    assert client.post(comments_url, headers=user_headers(), json={"content": "too late"}).status_code == 404
    assert client.delete(
        f"{comments_url}/{created.json()['comment']['id']}", headers=user_headers()
    ).status_code == 404


def test_report_comments_cascade_with_report_history_cleanup(client: TestClient):
    current_task = client.post(
        "/api/tasks", headers=user_headers(), json={"title": "Current comment cleanup"}
    ).json()["task"]
    current_report = client.post(
        f"/api/tasks/{current_task['id']}/reports", headers=user_headers(), json={"content": "Current report"}
    ).json()["report"]
    current_comment = client.post(
        f"/api/reports/{current_report['id']}/comments", headers=user_headers(), json={"content": "Remove on clear"}
    ).json()["comment"]
    assert client.delete(f"/api/history/tasks/{current_task['id']}", headers=user_headers()).status_code == 204
    assert client.get(f"/api/reports/{current_report['id']}/comments", headers=user_headers()).status_code == 404

    archived_task = client.post(
        "/api/tasks", headers=user_headers(), json={"title": "Archived comment cleanup"}
    ).json()["task"]
    archived_report = client.post(
        f"/api/tasks/{archived_task['id']}/reports", headers=user_headers(), json={"content": "Archived report"}
    ).json()["report"]
    archived_comment = client.post(
        f"/api/reports/{archived_report['id']}/comments", headers=user_headers(), json={"content": "Remove with archive"}
    ).json()["comment"]
    assert client.delete(
        f"/api/tasks/{archived_task['id']}", headers=user_headers(), params={"history": "keep"}
    ).status_code == 204
    assert client.delete(f"/api/history/tasks/{archived_task['id']}", headers=user_headers()).status_code == 204

    with client.app.state.test_session_factory() as db:
        assert db.get(ReportComment, UUID(current_comment["id"])) is None
        assert db.get(ReportComment, UUID(archived_comment["id"])) is None


def test_clearing_current_history_and_physical_delete_have_distinct_effects(client: TestClient):
    created = client.post("/api/tasks", headers=user_headers(), json={"title": "Keep current task"})
    assert created.status_code == 201
    task = created.json()["task"]
    task_id = task["id"]
    report = client.post(
        f"/api/tasks/{task_id}/reports", headers=user_headers(), json={"content": "Remove this report"}
    )
    assert report.status_code == 201

    cleared = client.delete(f"/api/history/tasks/{task_id}", headers=user_headers())
    assert cleared.status_code == 204
    current = client.get(f"/api/tasks/{task_id}", headers=user_headers())
    assert current.status_code == 200
    assert current.json()["task"] == task
    assert client.get(f"/api/tasks/{task_id}/reports", headers=user_headers()).json()["total"] == 0
    assert client.get("/api/activity", headers=user_headers(), params={"task_id": task_id}).json()["total"] == 0

    deleted = client.delete(f"/api/tasks/{task_id}?history=delete", headers=user_headers())
    assert deleted.status_code == 204
    assert client.get(f"/api/tasks/{task_id}", headers=user_headers()).status_code == 404
    assert client.get(f"/api/history/tasks/{task_id}", headers=user_headers()).status_code == 404


def test_activity_and_history_cleanup_are_workspace_scoped_and_user_only(client: TestClient):
    other_headers = user_headers(subject="activity-other-user", email="activity-other@example.test")
    assert client.post("/api/session/bootstrap", headers=other_headers).status_code == 200
    own_task = client.post("/api/tasks", headers=user_headers(), json={"title": "Own activity task"}).json()["task"]
    other_task = client.post("/api/tasks", headers=other_headers, json={"title": "Foreign activity task"}).json()["task"]
    own_events = client.get("/api/activity", headers=user_headers()).json()
    other_events = client.get("/api/activity", headers=other_headers).json()
    own_event = next(item for item in own_events["activities"] if item["task_id"] == own_task["id"])
    other_event = next(item for item in other_events["activities"] if item["task_id"] == other_task["id"])

    assert client.get(
        "/api/activity", headers=user_headers(), params={"task_id": other_task["id"]}
    ).json()["total"] == 0
    assert client.get(f"/api/history/tasks/{other_task['id']}", headers=user_headers()).status_code == 404
    assert client.delete(f"/api/activity/{other_event['id']}", headers=user_headers()).status_code == 404

    agent_secret = issue_agent_key(client, "History read-only Agent")
    agent = agent_headers(agent_secret)
    assert client.delete(f"/api/activity/{own_event['id']}", headers=agent).status_code == 403
    assert client.delete(f"/api/history/tasks/{own_task['id']}", headers=agent).status_code == 403
    assert client.delete(f"/api/tasks/{own_task['id']}?history=keep", headers=agent).status_code == 403

    assert client.delete(f"/api/activity/{own_event['id']}", headers=user_headers()).status_code == 204
    remaining = client.get(
        "/api/activity", headers=user_headers(), params={"task_id": own_task["id"], "source": "user"}
    )
    assert remaining.status_code == 200
    assert remaining.json()["total"] == 0
