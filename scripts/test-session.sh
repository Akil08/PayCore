
#!/usr/bin/env bash
set -euo pipefail

# Usage: bash scripts/test-session.sh
# Session number is generated automatically.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Find the next session number automatically.
mkdir -p test-runs
LAST=$(find test-runs -maxdepth 1 -type d -name 'session[0-9]*' \
  -printf '%f\n' 2>/dev/null |
  sed 's/session//' | sort -n | tail -1)

SESSION=$(( ${LAST:-0} + 1 ))
DB="paycore_test_session_${SESSION}"

echo "Preparing Session $SESSION"
echo "Test database: $DB"

# IMPORTANT: This command must be implemented to safely
# create the disposable database and apply your real schema.
npm run test:setup -- "$SESSION"

# Run the existing test suite for this session.
npm run test:session -- "$SESSION"

echo "Session $SESSION passed!"
