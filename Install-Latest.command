#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
printf '\n============================================================\n'
printf ' PlayAgent Checker - one-click latest installer / updater\n'
printf '============================================================\n\n'
if ! command -v node >/dev/null 2>&1; then
  printf '[FAILED] Node.js 22+ is required: https://nodejs.org/\n'
  read -r -p 'Press Enter to close...'
  exit 1
fi
node "./scripts/deploy-latest.mjs" "$@"
code=$?
printf '\n'
if [ "$code" -eq 0 ]; then
  printf '[SUCCESS] Latest PlayAgent Checker is installed and verified.\n'
else
  printf '[FAILED] Deployment stopped. Read the error and log path above.\n'
fi
read -r -p 'Press Enter to close...'
exit "$code"
