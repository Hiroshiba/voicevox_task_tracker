#!/usr/bin/env bash
set -euo pipefail

lease_ref='refs/heads/tracker-pages-effect-lease'
lease_path='state/production-pages-effect-lease-v1.json'
remote_ref="$(git ls-remote origin "$lease_ref")"
if [[ -z "$remote_ref" ]]; then
  exit 0
fi
revision="${remote_ref%%$'\t'*}"
if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'production Pages leaseのrevisionが不正です' >&2
  exit 1
fi
git fetch --no-tags origin "$lease_ref" >/dev/null
if [[ -z "$(git ls-tree "$revision" -- "$lease_path")" ]]; then
  echo 'production Pages lease branchに固定fileがありません' >&2
  exit 1
fi
lease_file="$RUNNER_TEMP/production-pages-lease.json"
git show "$revision:$lease_path" > "$lease_file"
if ! jq -e '.schemaVersion == 1 and .status == "released"' "$lease_file" >/dev/null; then
  echo 'production Pages childの効果が未確定です' >&2
  exit 1
fi
