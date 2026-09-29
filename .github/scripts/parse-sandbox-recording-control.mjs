import { appendFileSync } from "node:fs";
import process from "node:process";

import { z } from "zod";

const recordingControlSchema = z
  .strictObject({
    outcome: z.enum(["recorded_success", "recorded_clear_rejection", "recorded_ambiguous"]),
    messageIndex: z.number().int().nonnegative(),
    continuity: z
      .discriminatedUnion("phase", [
        z.strictObject({ phase: z.literal("first") }),
        z.strictObject({
          phase: z.literal("second"),
          firstRunId: z.string().regex(/^[1-9][0-9]*$/u),
          firstRunAttempt: z.number().int().positive(),
          firstTrackingRunId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
          firstFinalStateRevision: z.string().regex(/^[0-9a-f]{40}$/u),
          firstCodeRevision: z.string().regex(/^[0-9a-f]{40}$/u),
        }),
      ])
      .optional(),
  })
  .refine((control) => control.outcome !== "recorded_success" || control.messageIndex === 0, {
    message: "recorded_successのmessageIndexは0にしてください",
  });

const rawControl = process.env["SANDBOX_RECORDING_CONTROL"];
if (rawControl == null) {
  throw new TypeError("sandbox通知portの入力がありません");
}
const control = recordingControlSchema.parse(JSON.parse(rawControl));
const operation = process.env["SANDBOX_OPERATION"];
const action = process.env["SANDBOX_NOTIFICATION_ACTION"];
const scenarioId = process.env["SANDBOX_SCENARIO_ID"];
const environmentId = process.env["SANDBOX_ENVIRONMENT_ID"];
if ((scenarioId === "continuity") !== (control.continuity != null)) {
  throw new TypeError("continuity scenarioにはcontinuity controlが必要です");
}
if (control.continuity != null) {
  if (
    scenarioId !== "continuity" ||
    action !== "send" ||
    control.outcome !== "recorded_success" ||
    control.messageIndex !== 0
  ) {
    throw new TypeError("continuityにはsendとrecorded_successを指定してください");
  }
  if (control.continuity.phase === "first" && operation !== "create" && operation !== "reset") {
    throw new TypeError("continuity firstにはcreateまたはresetを指定してください");
  }
  if (control.continuity.phase === "second") {
    if (operation !== "continue") {
      throw new TypeError("continuity secondにはcontinueを指定してください");
    }
    if (
      environmentId !== `env-${control.continuity.firstRunId}-${control.continuity.firstRunAttempt}`
    ) {
      throw new TypeError("continuity secondのenvironment IDがfirstと一致しません");
    }
  }
}

const outputPath = process.env["GITHUB_OUTPUT"];
if (outputPath == null) {
  throw new TypeError("GitHub Actionsの出力先がありません");
}
appendFileSync(
  outputPath,
  [
    `recording_outcome=${control.outcome}`,
    `recording_message_index=${control.messageIndex}`,
    `continuity_phase=${control.continuity?.phase ?? "none"}`,
    `first_run_id=${control.continuity?.phase === "second" ? control.continuity.firstRunId : ""}`,
    `first_run_attempt=${control.continuity?.phase === "second" ? control.continuity.firstRunAttempt : ""}`,
    `first_tracking_run_id=${control.continuity?.phase === "second" ? control.continuity.firstTrackingRunId : ""}`,
    `first_final_state_revision=${control.continuity?.phase === "second" ? control.continuity.firstFinalStateRevision : ""}`,
    `first_code_revision=${control.continuity?.phase === "second" ? control.continuity.firstCodeRevision : ""}`,
    "",
  ].join("\n"),
);
