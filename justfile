default:
    @just --list

sync:
    uv sync --locked

frontend-sync:
    npm --prefix frontend ci

dev:
    uv run uvicorn jev_scam_detector.app:app --host 127.0.0.1 --port 8000

frontend-dev:
    npm --prefix frontend run dev

verify:
    bash scripts/verify.sh

browser-setup:
    cd frontend && npx playwright install --with-deps chromium

verify-browser:
    bash scripts/verify-browser.sh

lint:
    uv run ruff check .

format:
    uv run ruff format .

typecheck:
    uv run basedpyright

test:
    uv run pytest

frontend-typecheck:
    npm --prefix frontend run typecheck

frontend-test:
    npm --prefix frontend test

frontend-build:
    npm --prefix frontend run build

compose-config:
    docker compose config

compose-build:
    docker compose build

compose-up:
    docker compose up --build -d --wait

compose-down:
    docker compose down

compose-logs:
    docker compose logs -f

compose-ps:
    docker compose ps

render-build:
    docker build -t jev-render-smoke:local .

render-run:
    docker run --rm -p 127.0.0.1:10000:10000 -e RENDER_EXTERNAL_URL=http://127.0.0.1:10000 jev-render-smoke:local

smoke-containers:
    bash scripts/verify-render.sh

check: verify
