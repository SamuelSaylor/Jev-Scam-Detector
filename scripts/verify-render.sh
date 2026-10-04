#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

workdir=$(mktemp -d "${TMPDIR:-/tmp}/jev-container-smoke.XXXXXX")
project="jevsmoke$(basename "$workdir" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
: > "$workdir/empty.env"
container=
compose_env=()
compose() {
    env -i HOME="$HOME" PATH="$PATH" "${compose_env[@]}" docker compose --env-file "$workdir/empty.env" -p "$project" "$@"
}
cleanup() {
    compose down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
    docker image rm "$image" >/dev/null 2>&1 || true
    rm -rf "$workdir"
}
trap cleanup EXIT
free_port() {
    uv run python -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}
wait_for_api() {
    local ready=0
    for _ in $(seq 1 90); do
        if curl -fsS "$SMOKE_ORIGIN/api/health" >/dev/null 2>&1; then ready=1; break; fi
        sleep 1
    done
    if [[ "$ready" != 1 ]]; then
        echo "No healthy API at $SMOKE_ORIGIN" >&2
        if [[ -n "$container" ]]; then docker logs "$container"; else compose logs; fi
        return 1
    fi
}
probe() {
    uv run python - <<'PY'
import json
import os
import re
import urllib.error
import urllib.request
from websockets.exceptions import ConnectionClosedError
from websockets.sync.client import connect

origin = os.environ["SMOKE_ORIGIN"]

def get(path):
    try:
        with urllib.request.urlopen(origin + path, timeout=5) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read()

assert json.loads(get("/api/health")[2])["status"] == "ok"
assert b'<div id="root"></div>' in get("/")[2]
assert b'<div id="root"></div>' in get("/room/demo")[2]
status, headers, config = get("/config.json")
assert status == 200 and "application/json" in headers["Content-Type"]
assert headers["Cache-Control"] == "no-store"
assert isinstance(json.loads(config), dict)
assert get("/api/unknown")[0] == 404
assert get("/assets/missing.js")[0] == 404
preflight = urllib.request.Request(origin + "/api/sessions", method="OPTIONS", headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
with urllib.request.urlopen(preflight, timeout=5) as response:
    assert response.headers["Access-Control-Allow-Origin"] == origin
asset = re.search(rb'/assets/[^" ]+\.js', get("/")[2])
assert asset is not None
status, headers, body = get(asset.group().decode())
assert status == 200 and "javascript" in headers["Content-Type"] and len(body) > 1000
request = urllib.request.Request(origin + "/api/sessions", data=b'{"mode":"demo"}', headers={"Content-Type": "application/json"})
with urllib.request.urlopen(request, timeout=5) as response:
    room = json.load(response)
url = origin.replace("http://", "ws://") + "/api/sessions/" + room["sessionId"] + "/events"
with connect(url, origin=origin) as ws:
    ws.send(json.dumps({"type": "auth", "participantToken": room["participantToken"]}))
    assert json.loads(ws.recv(timeout=5))["type"] == "snapshot"
with connect(url, origin="https://wrong.example") as ws:
    try:
        ws.recv(timeout=5)
        raise AssertionError("wrong origin accepted")
    except ConnectionClosedError as exc:
        assert exc.rcvd.code == 4403
request = urllib.request.Request(origin + "/api/emails/scan", data=b'{"lines":[{"id":"a","sender":"a@b.c","text":"Hello"}]}', headers={"Content-Type": "application/json"})
try:
    urllib.request.urlopen(request, timeout=5)
    raise AssertionError("email scan accepted without bearer token")
except urllib.error.HTTPError as exc:
    assert exc.code == 401 and json.load(exc)["error"]["code"] == "invalid_token"
print("HTTP, JS, JSON, session, WebSocket origin and email auth passed at", origin)
PY
}

image="jev-render-smoke:$project"
docker build -t "$image" .
port=$(free_port)
container=$(env -u OPENAI_API_KEY -u TYPESAFE_API_KEY -u EMAIL_SCAN_TOKEN docker run -d \
    -p "127.0.0.1:$port:10000" -e PORT=10000 \
    -e RENDER_EXTERNAL_URL="http://127.0.0.1:$port" -e EMAIL_SCAN_TOKEN=verify-forwarding "$image")
export SMOKE_ORIGIN="http://127.0.0.1:$port"
wait_for_api
probe
for _ in $(seq 1 60); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
    if [[ "$status" == healthy ]]; then break; fi
    if [[ "$status" == unhealthy ]]; then echo 'Render container unhealthy' >&2; exit 1; fi
    sleep 1
done
[[ "$status" == healthy ]]
docker stop -t 10 "$container" >/dev/null
[[ $(docker inspect --format '{{.State.ExitCode}}' "$container") == 0 ]]
echo 'Render container healthy and stopped cleanly after SIGTERM'

port=$(free_port)
export SMOKE_ORIGIN="http://127.0.0.1:$port"
compose_env=(FRONTEND_ORIGIN="$SMOKE_ORIGIN" WEB_BIND_ADDRESS=127.0.0.1 WEB_PORT="$port" EMAIL_SCAN_TOKEN=verify-forwarding)
compose config --format json | uv run python -c 'import json, sys; e = json.load(sys.stdin)["services"]["backend"]["environment"]; assert e["EMAIL_SCAN_TOKEN"] == "verify-forwarding" and not e["OPENAI_API_KEY"] and not e["TYPESAFE_API_KEY"]'
compose up --build -d --wait
wait_for_api
probe
for service in backend frontend; do
    id=$(compose ps -q "$service")
    [[ $(docker inspect --format '{{.State.Health.Status}}' "$id") == healthy ]]
done
ids=$(compose ps -q)
compose stop -t 10
for id in $ids; do
    [[ $(docker inspect --format '{{.State.ExitCode}}' "$id") == 0 ]]
done
echo 'Compose backend and frontend healthy and stopped cleanly after SIGTERM'
