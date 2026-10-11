#!/usr/bin/env bash

set -euo pipefail

cp "$RUNNER_TEMP/sandbox-state/state/sandbox-environment.json" "$RUNNER_TEMP/matrix-current/sandbox-environment.json"
cp "$RUNNER_TEMP/sandbox-state/state/durable-publication-record-v1.json" "$RUNNER_TEMP/matrix-current/durable-publication-record-v1.json"

for destination in "$RUNNER_TEMP"/prior/* "$RUNNER_TEMP/matrix-current"; do
  manifest="$destination/sandbox-environment.json"
  source_environment_id="$(jq -er '.lifecycle.creation.sourceEnvironmentId | select(test("^env-[1-9][0-9]*-[1-9][0-9]*$"))' "$manifest")"
  expected_head="$(jq -er '.lifecycle.creation.sourceHeadRevision | select(test("^[0-9a-f]{40}$"))' "$manifest")"
  git fetch --no-tags origin "refs/heads/sandbox-state/$source_environment_id:refs/remotes/sandbox-matrix-source/$source_environment_id"
  source_head="$(git rev-parse "refs/remotes/sandbox-matrix-source/$source_environment_id")"
  if [[ "$source_head" != "$expected_head" ]]; then
    echo 'reset元environmentのHEADが一致しません' >&2
    exit 1
  fi
  git show "$source_head:state/sandbox-environment.json" > "$destination/source-environment.json"
  source_final="$(jq -er '.lifecycle.completion.finalStateRevision | select(test("^[0-9a-f]{40}$"))' "$destination/source-environment.json")"
  seed_revision="$(jq -er '.seedRevision | select(test("^[0-9a-f]{40}$"))' "$destination/source-environment.json")"
  if [[ "$(git rev-parse "$source_head^")" != "$source_final" ]] ||
    [[ "$(git diff --name-only "$source_final" "$source_head")" != 'state/sandbox-environment.json' ]]; then
    echo 'reset元のready commitが不正です' >&2
    exit 1
  fi
  branch_root="$(git rev-list --first-parent --reverse "$seed_revision..$source_head" | sed -n '1p')"
  if [[ -z "$branch_root" ]] || [[ "$(git rev-parse "$branch_root^")" != "$seed_revision" ]] ||
    ! git show "$branch_root:state/sandbox-environment.json" |
      jq -e --arg seed "$seed_revision" --arg environment "$source_environment_id" \
        '.seedRevision == $seed and .environmentId == $environment and .lifecycle.status == "preparing"' >/dev/null; then
    echo 'reset元environmentのseed commitが一致しません' >&2
    exit 1
  fi
  printf '%s\n' "$source_head" > "$destination/source-head-revision.txt"
done
