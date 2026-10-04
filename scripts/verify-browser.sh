#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
npm --prefix frontend run test:e2e
