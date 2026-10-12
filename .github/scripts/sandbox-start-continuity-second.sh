#!/usr/bin/env bash

set -euo pipefail

control="$(cat "$RUNNER_TEMP/continuity-second-control.json")"
gh workflow run sandbox.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" \
  -f operation=continue \
  -f source_ref="$SANDBOX_SOURCE_REF" \
  -f environment_id="$SANDBOX_ENVIRONMENT_ID" \
  -f analysis_mode=cache_probe \
  -f notification_action=send \
  -f scenario_id=continuity \
  -f recording_control="$control"
