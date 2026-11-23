#!/usr/bin/env bash
# Run from the repository root; prepare the expected patch independently.
set -euo pipefail
if [[ $# -ne 1 ]]; then
  printf 'Usage: bash %s <expected.patch>\n' "$0" >&2
  exit 2
fi
untracked=$(git ls-files --others --exclude-standard)
if [[ -n "$untracked" ]]; then
  printf 'Unexpected untracked files:\n%s\n' "$untracked" >&2
  exit 1
fi
git diff --cached --quiet HEAD -- || { printf 'Unexpected staged changes\n' >&2; exit 1; }
git diff --binary --no-ext-diff --no-textconv --no-color HEAD -- | cmp - "$1"
