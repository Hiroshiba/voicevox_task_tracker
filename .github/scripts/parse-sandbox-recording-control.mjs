import { appendFileSync } from "node:fs";
import process from "node:process";

import { z } from "zod";

const recordingControlSchema = z
  .strictObject({
    outcome: z.enum(["recorded_success", "recorded_clear_rejection", "recorded_ambiguous"]),
    messageIndex: z.number().int().nonnegative(),
  })
  .refine((control) => control.outcome !== "recorded_success" || control.messageIndex === 0, {
    message: "recorded_successのmessageIndexは0にしてください",
  });

const rawControl = process.env["SANDBOX_RECORDING_CONTROL"];
if (rawControl == null) {
  throw new TypeError("sandbox通知portの入力がありません");
}
const control = recordingControlSchema.parse(JSON.parse(rawControl));

const outputPath = process.env["GITHUB_OUTPUT"];
if (outputPath == null) {
  throw new TypeError("GitHub Actionsの出力先がありません");
}
appendFileSync(
  outputPath,
  `recording_outcome=${control.outcome}\nrecording_message_index=${control.messageIndex}\n`,
);
