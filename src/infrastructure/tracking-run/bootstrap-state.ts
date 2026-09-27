import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../../application/tracking-run/contracts/recovery-paths.js";
import {
  readDurablePublicationRecoveryBootstrap,
  readRunTransactionMarkerRecoveryBootstrap,
  type DurablePublicationRecoveryBootstrapV1,
  type RunTransactionMarkerRecoveryBootstrapV1,
} from "../../application/tracking-run/recovery-bootstrap.js";
import type { StateBranchAdapter, StateBranchHead } from "../../persistence/branch-adapter.js";
import { nodeContentDigestPort } from "./content-digest.js";

/** 同じstate revisionのbootstrapだけから選ぶ起動経路。 */
export type RuntimeLaunchDecision =
  | Readonly<{
      kind: "start_with_current_runtime";
      observedStateHead: StateBranchHead;
    }>
  | Readonly<{
      kind: "resume_with_exact_runtime";
      observedStateHead: Extract<StateBranchHead, { status: "present" }>;
      marker: RunTransactionMarkerRecoveryBootstrapV1;
      record: DurablePublicationRecoveryBootstrapV1;
    }>
  | Readonly<{
      kind: "manual_resolution_required";
      observedStateHead: Extract<StateBranchHead, { status: "present" }>;
      cause: Error;
    }>;

function manualResolution(
  observedStateHead: Extract<StateBranchHead, { status: "present" }>,
  cause: Error,
): RuntimeLaunchDecision {
  return Object.freeze({ kind: "manual_resolution_required", observedStateHead, cause });
}

/** markerとrecordを一つのexact revisionから読み、現行runtimeを起動できるか判定する。 */
export async function inspectRunBootstrapState(
  adapter: StateBranchAdapter,
  branch: string,
): Promise<RuntimeLaunchDecision> {
  const observedStateHead = await adapter.resolveHead(branch);
  if (observedStateHead.status === "missing") {
    return Object.freeze({ kind: "start_with_current_runtime", observedStateHead });
  }
  const files = await adapter.readFiles(observedStateHead.revision, [
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  ]);
  const markerFile = files.get(RUN_TRANSACTION_MARKER_STATE_PATH_V1);
  const recordFile = files.get(DURABLE_PUBLICATION_RECORD_STATE_PATH_V1);
  if (markerFile == null || recordFile == null) {
    throw new TypeError("state bootstrapの一括読取結果が不足しています");
  }
  if (markerFile.status === "missing" && recordFile.status === "missing") {
    return Object.freeze({ kind: "start_with_current_runtime", observedStateHead });
  }
  if (markerFile.status === "missing" || recordFile.status === "missing") {
    return manualResolution(
      observedStateHead,
      new TypeError("transaction markerとdurable recordの片方がありません"),
    );
  }
  let marker: RunTransactionMarkerRecoveryBootstrapV1;
  let record: DurablePublicationRecoveryBootstrapV1;
  try {
    marker = readRunTransactionMarkerRecoveryBootstrap(markerFile.bytes);
    record = readDurablePublicationRecoveryBootstrap(recordFile.bytes, nodeContentDigestPort);
  } catch (error: unknown) {
    return manualResolution(
      observedStateHead,
      new TypeError("state bootstrapの検証に失敗しました", { cause: error }),
    );
  }
  if (
    marker.runId !== record.runId ||
    marker.checkpointDigest !== record.checkpointDigest ||
    marker.publicationRecordDigest !== record.recordDigest
  ) {
    return manualResolution(
      observedStateHead,
      new TypeError("transaction markerとdurable recordが一致しません"),
    );
  }
  if (marker.phase === "run_finalized") {
    return Object.freeze({ kind: "start_with_current_runtime", observedStateHead });
  }
  return Object.freeze({ kind: "resume_with_exact_runtime", observedStateHead, marker, record });
}
