#!/usr/bin/env bash

set -euo pipefail

node recovery-source/.github/scripts/sandbox-cache-probe.mjs select
control="$(jq -cn \
  --arg firstRunId "$GITHUB_RUN_ID" \
  --argjson firstRunAttempt "$GITHUB_RUN_ATTEMPT" \
  --arg firstTrackingRunId "$SANDBOX_TRACKING_RUN_ID" \
  --arg firstFinalStateRevision "$SANDBOX_FINAL_REVISION" \
  --arg firstCodeRevision "$SANDBOX_CODE_REVISION" \
  --slurpfile cacheProbe "$SANDBOX_CACHE_PROBE_OUTPUT_PATH" \
  '{outcome: "recorded_success", messageIndex: 0, continuity: {phase: "second", firstRunId: $firstRunId, firstRunAttempt: $firstRunAttempt, firstTrackingRunId: $firstTrackingRunId, firstFinalStateRevision: $firstFinalStateRevision, firstCodeRevision: $firstCodeRevision, cacheProbe: $cacheProbe[0]}}')"
gh workflow run sandbox.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" \
  -f operation=continue \
  -f source_ref="$SANDBOX_SOURCE_REF" \
  -f environment_id="$SANDBOX_ENVIRONMENT_ID" \
  -f analysis_mode=cache_probe \
  -f notification_action=send \
  -f scenario_id=continuity \
  -f recording_control="$control"
