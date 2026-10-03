# List available recipes
default:
    @just --list
# Install dependencies
sync:
    uv sync
# Run fastapi in development mode
dev:
    uv run fastapi dev
# Run fastapi in production mode
prod:
    uv run fastapi run
# Run the test suite
test:
    uv run python -m pytest
# Format code with ruff
format:
    uv run ruff format .
# Check linting rules
lint:
    uv run ruff check .
# Apply safe lint fixes
lint-fix:
    uv run ruff check --fix .
# Run static type checking
typecheck:
    uv run basedpyright
# Check formatting, linting, typechecks, and test suite
check: lint typecheck test
    uv run ruff format --check .
    echo "All checks passed!"
