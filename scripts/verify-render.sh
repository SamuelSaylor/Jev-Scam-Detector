#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
EMAIL_SCAN_TOKEN=verify-forwarding docker compose config --format json | uv run python -c 'import json, sys; assert json.load(sys.stdin)["services"]["backend"]["environment"]["EMAIL_SCAN_TOKEN"] == "verify-forwarding"'
image="jev-render-smoke:local"
docker build -t "$image" .
port=${VERIFY_RENDER_PORT:-18763}
container=$(docker run -d -p "127.0.0.1:$port:$port" -e PORT="$port" -e RENDER_EXTERNAL_URL="http://127.0.0.1:$port" "$image")
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
export SMOKE_ORIGIN="http://127.0.0.1:$port"
ready=0
for _ in $(seq 1 60); do
    if curl -fsS "$SMOKE_ORIGIN/api/health" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
done
if [ "$ready" != 1 ]; then docker logs "$container"; exit 1; fi
uv run python - <<'PY'
import json
import os
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
assert get("/config.json")[1]["Cache-Control"] == "no-store"
assert get("/api/unknown")[0] == 404
assert get("/assets/missing.js")[0] == 404
preflight = urllib.request.Request(origin + "/api/sessions", method="OPTIONS", headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
with urllib.request.urlopen(preflight, timeout=5) as response:
    assert response.headers["Access-Control-Allow-Origin"] == origin
_, _, page = get("/")
import re
asset = re.search(rb'/assets/[^" ]+\.js', page)
assert asset is not None
assert get(asset.group().decode())[0] == 200
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
print("Render image HTTP, assets, config, session and WebSocket origin checks passed")
PY
status=starting
for _ in $(seq 1 60); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
    if [ "$status" = healthy ]; then break; fi
    if [ "$status" = unhealthy ]; then echo 'Docker health check failed'; exit 1; fi
    sleep 1
done
[ "$status" = healthy ] || { echo 'Docker health check timed out'; exit 1; }
docker stop -t 10 "$container" >/dev/null
[ "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0 ]
echo 'Container stopped cleanly after SIGTERM'
