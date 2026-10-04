default:
    @just --list

sync:
    uv sync --locked

dev:
    uv run uvicorn jev_scam_detector.app:app --host 127.0.0.1 --port 8000

verify:
    bash scripts/verify.sh

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

check: verify
