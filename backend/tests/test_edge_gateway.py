from conftest import WEB_TOKEN
from fastapi.testclient import TestClient


def test_origin_gateway_enforces_an_independent_secret(client: TestClient, monkeypatch):
    secret = "gateway-" + "g" * 56
    monkeypatch.setenv("EDGE_GATEWAY_TOKEN", secret)
    browser_headers = {"Authorization": "Bearer " + WEB_TOKEN}

    assert client.get("/api/health").status_code == 403
    assert client.get("/api/tasks", headers=browser_headers).status_code == 403

    headers = {**browser_headers, "X-Tasklutein-Gateway": "incorrect"}
    assert client.get("/api/tasks", headers=headers).status_code == 403

    headers["X-Tasklutein-Gateway"] = secret
    assert client.get("/api/tasks", headers=headers).status_code == 200
    assert client.get("/api/health", headers={"X-Tasklutein-Gateway": secret}).status_code == 200


def test_gateway_fails_closed_on_short_secret(client: TestClient, monkeypatch):
    monkeypatch.setenv("EDGE_GATEWAY_TOKEN", "short")
    assert client.get("/api/health").status_code == 503
