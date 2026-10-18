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
