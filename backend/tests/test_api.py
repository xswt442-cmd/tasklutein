import io

from app.database import get_db
from app.main import app, logger
from conftest import AGENT_TOKEN, WEB_TOKEN
from fastapi.testclient import TestClient


def auth(token: str) -> dict[str, str]:
    return {"Authorization": "Bearer " + token}


def test_health_and_auth(client: TestClient):
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/tasks").status_code == 401
    assert client.get("/api/tasks", headers=auth("incorrect")).status_code == 401
    assert client.get("/api/tasks", headers=auth(WEB_TOKEN)).json() == {
        "tasks": [], "total": 0, "limit": 200, "offset": 0
    }
    assert client.get("/api/ready", headers=auth(WEB_TOKEN)).json() == {"status": "ready"}


def test_api_generates_request_ids_and_rejects_forged_origin_ids(client: TestClient):
    headers_with_invalid_id = {**auth(WEB_TOKEN), "X-Request-ID": "caller-supplied"}
    response = client.get("/api/tasks", headers=headers_with_invalid_id)
    assert response.status_code == 200
    assert response.headers["X-Request-ID"] != "caller-supplied"
    assert response.json()["tasks"] == []

    response = client.get("/api/tasks", headers={"X-Request-ID": "caller-supplied"})
    assert response.status_code == 401
    assert response.headers["X-Request-ID"] != "caller-supplied"


def test_request_completion_is_written_to_stderr(client: TestClient):
    handler = logger.handlers[0]
    original_stream = handler.stream
    capture = io.StringIO()
    handler.setStream(capture)
    try:
        response = client.get("/api/health")
    finally:
        handler.setStream(original_stream)
    assert response.status_code == 200

    output = capture.getvalue()
    events = [line for line in output.splitlines() if '"event":"request_complete"' in line]
    assert events
    assert '"request_id":"' + response.headers["X-Request-ID"] + '"' in events[-1]
    assert '"route":"/api/health"' in events[-1]
    assert '"status":200' in events[-1]


def test_unexpected_error_has_common_headers_and_safe_body(client: TestClient):
    class BrokenSession:
        def execute(self, _statement):
            raise RuntimeError("private database failure")

    def failing_db():
        yield BrokenSession()

    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = failing_db
    try:
        with TestClient(app, raise_server_exceptions=False) as test_client:
            response = test_client.get("/api/ready", headers=auth(WEB_TOKEN))
        assert response.status_code == 500, response.text
        assert response.headers["X-Request-ID"] == response.json()["request_id"]
        assert response.headers["Cache-Control"] == "no-store"
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.json()["code"] == "internal_error"
        assert "private database failure" not in response.text
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous
def test_api_errors_include_safe_codes_and_request_ids(client: TestClient):
    missing = client.get(
        "/api/tasks/00000000-0000-4000-8000-000000000001",
        headers=auth(WEB_TOKEN),
    )
    assert missing.status_code == 404
    assert missing.json()["detail"] == "task_not_found"
    assert missing.json()["code"] == "task_not_found"
    assert missing.json()["request_id"] == missing.headers["X-Request-ID"]

    invalid = client.post(
        "/api/tasks",
        headers=auth(WEB_TOKEN),
        json={"title": "Sensitive title that exceeds the allowed field length " + "x" * 120},
    )
    assert invalid.status_code == 422
    assert invalid.json()["code"] == "validation_error"
    assert invalid.json()["request_id"] == invalid.headers["X-Request-ID"]
    assert "input" not in str(invalid.json()["detail"])
    assert "Sensitive title" not in str(invalid.json())


def test_task_search_pagination_and_overview_use_the_full_workspace(client: TestClient):
    first = client.post(
        "/api/tasks",
        headers=auth(WEB_TOKEN),
        json={"title": "Plan 50%_Release", "description": "prepare the handoff"},
    )
    second = client.post("/api/tasks", headers=auth(WEB_TOKEN), json={"title": "Release notes"})
    third = client.post(
        "/api/tasks",
        headers=auth(WEB_TOKEN),
        json={"title": "Archive report", "status": "in_progress"},
    )
    assert [first.status_code, second.status_code, third.status_code] == [201, 201, 201]

    literal_search = client.get(
        "/api/tasks", headers=auth(WEB_TOKEN), params={"q": "50%_release", "limit": 25}
    )
    assert literal_search.status_code == 200
    assert literal_search.json()["total"] == 1
    assert literal_search.json()["tasks"][0]["id"] == first.json()["task"]["id"]

    page_one = client.get(
        "/api/tasks", headers=auth(WEB_TOKEN), params={"status": "todo", "limit": 1, "offset": 0}
    )
    page_two = client.get(
        "/api/tasks", headers=auth(WEB_TOKEN), params={"status": "todo", "limit": 1, "offset": 1}
    )
    assert page_one.status_code == page_two.status_code == 200
    assert page_one.json()["total"] == page_two.json()["total"] == 2
    assert page_one.json()["limit"] == page_two.json()["limit"] == 1
    assert page_one.json()["offset"] == 0
    assert page_two.json()["offset"] == 1
    assert page_one.json()["tasks"][0]["id"] != page_two.json()["tasks"][0]["id"]

    overview = client.get("/api/overview", headers=auth(WEB_TOKEN))
    assert overview.status_code == 200
    assert overview.json()["total"] == 3
    assert overview.json()["by_status"] == {"todo": 2, "in_progress": 1, "done": 0}
    assert overview.json()["generated_at"].endswith("Z")

    assert client.get("/api/tasks?limit=0", headers=auth(WEB_TOKEN)).status_code == 422
    assert client.get("/api/tasks?sort=client_supplied_sql", headers=auth(WEB_TOKEN)).status_code == 422


def test_task_lifecycle_and_agent_report_source(client: TestClient):
    created = client.post("/api/tasks", headers=auth(WEB_TOKEN), json={"title": "  Ship feature  "})
    assert created.status_code == 201
    task = created.json()["task"]
    assert task["title"] == "Ship feature"
    assert task["status"] == "todo"

    task_id = task["id"]
    assert client.get("/api/tasks", headers=auth(AGENT_TOKEN)).json()["tasks"][0]["id"] == task_id

    updated = client.patch(
        "/api/tasks/" + task_id,
        headers=auth(AGENT_TOKEN),
        json={"status": "done"},
    )
    assert updated.status_code == 200
    assert updated.json()["task"]["status"] == "done"

    added = client.post(
        "/api/tasks/" + task_id + "/reports",
        headers=auth(AGENT_TOKEN),
        json={"content": "Verified after running tests."},
    )
    assert added.status_code == 201
    assert added.json()["report"]["source"] == "agent"
    reports = client.get("/api/tasks/" + task_id + "/reports", headers=auth(WEB_TOKEN)).json()
    assert len(reports["reports"]) == 1

    assert client.delete("/api/tasks/" + task_id, headers=auth(WEB_TOKEN)).status_code == 204
    assert client.get("/api/tasks/" + task_id, headers=auth(WEB_TOKEN)).status_code == 404
    assert client.get("/api/tasks/" + task_id + "/reports", headers=auth(WEB_TOKEN)).status_code == 404


def test_validation(client: TestClient):
    assert client.post("/api/tasks", headers=auth(WEB_TOKEN), json={"title": " "}).status_code == 422
    assert client.post("/api/tasks", headers=auth(WEB_TOKEN), json={"title": "ok", "source": "agent"}).status_code == 422
    created = client.post("/api/tasks", headers=auth(WEB_TOKEN), json={"title": "valid"})
    task_id = created.json()["task"]["id"]
    assert client.patch("/api/tasks/" + task_id, headers=auth(WEB_TOKEN), json={}).status_code == 422
    assert client.post(
        "/api/tasks/" + task_id + "/reports",
        headers=auth(WEB_TOKEN),
        json={"content": "report", "source": "agent"},
    ).status_code == 422
    assert client.get("/api/tasks", headers=auth(WEB_TOKEN), params={"status": "unknown"}).status_code == 422
