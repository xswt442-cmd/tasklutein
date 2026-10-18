from conftest import GATEWAY_TOKEN, gateway_headers, user_headers
from fastapi.testclient import TestClient


def test_origin_gateway_enforces_an_independent_secret(client: TestClient, monkeypatch):
    secret = "gateway-" + "g" * 56
    monkeypatch.setenv("EDGE_GATEWAY_TOKEN", secret)
    browser_headers = user_headers()

    missing_gateway = client.get("/api/health")
    assert missing_gateway.status_code == 403
    assert missing_gateway.json()["code"] == "invalid_gateway"
    assert missing_gateway.json()["request_id"] == missing_gateway.headers["X-Request-ID"]
    assert client.get("/api/tasks", headers=browser_headers).status_code == 403

    headers = {**browser_headers, "X-Tasklutein-Gateway": "incorrect"}
    assert client.get("/api/tasks", headers=headers).status_code == 403

    headers["X-Tasklutein-Gateway"] = secret
    assert client.get("/api/tasks", headers=headers).status_code == 200
    assert client.get("/api/health", headers={"X-Tasklutein-Gateway": secret}).status_code == 200

    request_id = "00000000-0000-4000-8000-000000000001"
    traced = client.get(
        "/api/health",
        headers={"X-Tasklutein-Gateway": secret, "X-Request-ID": request_id},
    )
    assert traced.status_code == 200
    assert traced.headers["X-Request-ID"] == request_id


def test_gateway_fails_closed_on_short_secret(client: TestClient, monkeypatch):
    monkeypatch.setenv("EDGE_GATEWAY_TOKEN", "short")
    response = client.get("/api/health", headers=gateway_headers())
    assert response.status_code == 503
    assert response.json()["code"] == "gateway_not_configured"
    assert response.json()["request_id"] == response.headers["X-Request-ID"]


def test_origin_gateway_rejects_large_rest_bodies(client: TestClient, monkeypatch):
    gateway = "gateway-" + "g" * 56
    monkeypatch.setenv("EDGE_GATEWAY_TOKEN", gateway)
    headers = {**user_headers(), "X-Tasklutein-Gateway": gateway}
    response = client.post(
        "/api/tasks",
        headers=headers,
        content="x" * (64 * 1024 + 1),
    )
    assert response.status_code == 413
    assert response.json()["code"] == "request_too_large"
    assert response.json()["request_id"] == response.headers["X-Request-ID"]


def test_gateway_fixture_uses_a_long_secret():
    assert len(GATEWAY_TOKEN) >= 32
