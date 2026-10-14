from conftest import AGENT_TOKEN, WEB_TOKEN
from fastapi.testclient import TestClient


def auth(token: str) -> dict[str, str]:
    return {"Authorization": "Bearer " + token}


def test_health_and_auth(client: TestClient):
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/tasks").status_code == 401
    assert client.get("/api/tasks", headers=auth("incorrect")).status_code == 401
    assert client.get("/api/tasks", headers=auth(WEB_TOKEN)).json() == {"tasks": []}


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
