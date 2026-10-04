#!/usr/bin/env bash
set -euo pipefail

for tool in docker ngrok curl jq python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Demo requires $tool." >&2
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo 'Demo requires Docker Compose and a running Docker daemon.' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo 'Docker daemon is unavailable.' >&2
  exit 1
fi

# Compose resolves WEB_PORT from the shell and .env with its own precedence rules.
port_binding=$(docker compose config --format json | jq -er '[.services.frontend.ports[] | select(.target == 8080 and .protocol == "tcp")] | if length == 1 then .[0] | [.host_ip, .published] | @tsv else empty end') || {
  echo 'Expected one Compose frontend TCP port binding to container port 8080.' >&2
  exit 1
}
IFS=$'\t' read -r bind_address web_port <<< "$port_binding"
if [[ "$bind_address" != 127.0.0.1 || ! "$web_port" =~ ^[0-9]+$ ]] || (( 10#$web_port < 1 || 10#$web_port > 65535 )); then
  echo 'Demo requires a loopback WEB_BIND_ADDRESS and a valid WEB_PORT.' >&2
  exit 1
fi

config_check=$(ngrok config check 2>/dev/null) || {
  echo 'ngrok configuration is invalid. Sign in with the ngrok CLI before running the demo.' >&2
  exit 1
}
if [[ "$config_check" != 'Valid configuration file at '* ]]; then
  echo 'Could not locate the ngrok CLI configuration.' >&2
  exit 1
fi
ngrok_config=${config_check#Valid configuration file at }

work_dir=$(mktemp -d)
ngrok_pid=''
cleanup() {
  if [[ -n "$ngrok_pid" ]]; then
    kill "$ngrok_pid" 2>/dev/null || true
    wait "$ngrok_pid" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

inspector_port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
printf 'version: "3"\nagent:\n  web_addr: 127.0.0.1:%s\n' "$inspector_port" > "$work_dir/inspector.yml"
upstream="http://127.0.0.1:$web_port"
ngrok http "$upstream" --config "$ngrok_config" --config "$work_dir/inspector.yml" --inspect=false --log=false >"$work_dir/ngrok-output" 2>&1 &
ngrok_pid=$!

origin=''
for ((attempt = 0; attempt < 30; attempt++)); do
  if ! kill -0 "$ngrok_pid" 2>/dev/null; then
    echo 'ngrok exited before opening a tunnel. Check your CLI login, account limits, and network connection.' >&2
    exit 1
  fi
  tunnels=$(curl -fsS --max-time 1 "http://127.0.0.1:$inspector_port/api/tunnels" 2>/dev/null) || tunnels=''
  if [[ -n "$tunnels" ]]; then
    origin=$(jq -er --arg upstream "$upstream" '[.tunnels[] | select(.proto == "https" and .config.addr == $upstream) | .public_url] | if length == 1 then .[0] else empty end' <<< "$tunnels" 2>/dev/null) || origin=''
    if [[ -n "$origin" ]]; then break; fi
  fi
  sleep 1
done
if ! kill -0 "$ngrok_pid" 2>/dev/null; then
  echo 'ngrok exited before opening a tunnel. Check your CLI login, account limits, and network connection.' >&2
  exit 1
fi
if [[ ! "$origin" =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]+)?$ ]]; then
  echo 'ngrok did not provide one valid HTTPS origin within 30 checks.' >&2
  exit 1
fi

FRONTEND_ORIGIN="$origin" docker compose up --build -d --wait --wait-timeout 120 || {
  echo 'Docker Compose could not make the demo healthy. Containers may remain running.' >&2
  exit 1
}

ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if ! kill -0 "$ngrok_pid" 2>/dev/null; then
    echo 'ngrok stopped while waiting for the public app.' >&2
    exit 1
  fi
  if curl -fsS --max-time 3 -H 'ngrok-skip-browser-warning: true' "$origin/api/health" 2>/dev/null | jq -e '.status == "ok"' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'Public app did not become ready within 30 checks. Containers may remain running.' >&2
  exit 1
fi

printf 'Public demo: %s\n' "$origin"
echo 'Press Ctrl+C to stop this tunnel. Compose containers stay running.'
wait "$ngrok_pid" || {
  echo 'ngrok stopped. Compose containers stay running.' >&2
  exit 1
}
echo 'ngrok stopped. Compose containers stay running.' >&2
exit 1
