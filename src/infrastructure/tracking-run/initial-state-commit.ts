import { randomUUID } from "node:crypto";

import { stateCommitReceiptOperationId } from "../../application/tracking-run/observed-state-commit.js";
import { createReceipt } from "../../application/tracking-run/receipt-codec.js";
import type { InitialStateCommitReceipt } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  StateBranchCommitError,
  StateBranchConflictError,
  writeStateCas,
  type StateBranchAdapter,
  type StateBranchHead,
  type StatePersistenceConfiguration,
} from "../../persistence/index.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { materializeDurablePublicationRecord } from "./durable-record.js";
import { verifyInitialStateCandidate } from "./initial-state-commit-candidate.js";
import { prepareInitialStateFiles } from "./initial-state-commit-files.js";
import {
  assertBoundPublicationCheckpoint,
  type BoundPublicationCheckpoint,
} from "./publication-checkpoint-binding.js";
import { observeStateCommitAtRevision } from "./state-receipt-observation.js";

/** 初回state commitで使用する副作用境界。 */
export type InitialStateCommitPort = Readonly<{
  adapter: StateBranchAdapter;
  configuration: StatePersistenceConfiguration;
  migrationTimezone: string;
  knownSecrets: readonly string[];
  now: () => Date;
}>;

/** 初回state commitの確定revisionと実行または再観測receipt。 */
export type InitialStateCommitResult = Readonly<{
  revision: string;
  receipt: InitialStateCommitReceipt;
}>;

function checkpointBaseHead(bound: BoundPublicationCheckpoint): StateBranchHead {
  const base = bound.checkpoint.baseStateRevision;
  return base.status === "missing"
    ? Object.freeze({ status: "missing" })
    : Object.freeze({ status: "present", revision: base.revision });
}

/** 検証済みcheckpointだけから初回stateを単一CAS commitへ保存する。 */
export async function commitInitialState(
  bound: BoundPublicationCheckpoint,
  statePort: InitialStateCommitPort,
): Promise<InitialStateCommitResult> {
  assertBoundPublicationCheckpoint(bound);
  const record = materializeDurablePublicationRecord(bound, digest);
  if (
    record.runtimeRecoveryPlan.kind === "not_reproducible" &&
    record.executionPolicy.effectTarget !== "recording"
  ) {
    throw new TypeError("回復不能なruntimeで永続stateへ初回commitできません");
  }
  const template = bound.publicationPlan.initialStateWriteSet.markerTemplate;
  if (
    serializeCanonicalJson(template.runIdentity) !== serializeCanonicalJson(record.runIdentity) ||
    serializeCanonicalJson(template.baseStateRevision) !==
      serializeCanonicalJson(record.baseStateRevision) ||
    serializeCanonicalJson(template.initialStateValueDigests) !==
      serializeCanonicalJson(record.initialStateContentDigests)
  ) {
    throw new TypeError("初回marker templateがcheckpointと一致しません");
  }
  const expectedHead = checkpointBaseHead(bound);
  const operationId = stateCommitReceiptOperationId(
    "initial_state_commit",
    record.runIdentity.runId,
    record.checkpointDigest,
    digest,
  );
  const invocationId = randomUUID();
  const message = `tracker initial state ${bound.publicationPlan.initialStateWriteSet.snapshot.generatedAt.slice(0, 10)} ${record.runIdentity.runId}`;
  const commitIdentity = Object.freeze({
    commitScope: "tracking_run" as const,
    operationId,
    runId: record.runIdentity.runId,
  });
  const written = await writeStateCas(statePort.adapter, statePort.configuration, expectedHead, {
    commitIdentity,
    build: async (parent) => {
      const files = await prepareInitialStateFiles(
        bound,
        record,
        statePort.adapter,
        statePort.configuration,
        statePort.migrationTimezone,
        parent,
        statePort.knownSecrets,
      );
      return {
        updates: files.updates,
        deletions: files.deletions,
        message,
        committedAt: bound.publicationPlan.initialStateWriteSet.snapshot.generatedAt,
        commitIdentity,
      };
    },
    verifyCandidate: (files, _revision, request) => {
      verifyInitialStateCandidate(
        bound,
        record,
        statePort.configuration,
        files,
        request.updates,
        statePort.knownSecrets,
      );
    },
  });
  if (written.status === "conflict") {
    throw new StateBranchConflictError();
  }
  if (written.status === "no_effect") {
    throw new StateBranchCommitError({
      cause: new TypeError("初回state commitをremoteへ反映できませんでした"),
    });
  }
  const observed = await observeStateCommitAtRevision(
    statePort.adapter,
    statePort.configuration,
    written.commit.revision,
    written.commit.revision,
    "initial_state_commit",
    {
      invocationId,
      observedAt: statePort.now().toISOString(),
      position: { kind: "first" },
    },
  );
  if (observed.receipt.receiptType !== "initial_state_commit") {
    throw new TypeError("初回state commitの再観測receipt種別が不正です");
  }
  if (written.observed) {
    return Object.freeze({ revision: written.commit.revision, receipt: observed.receipt });
  }
  const executed = createReceipt(
    {
      schemaVersion: 1,
      receiptType: "initial_state_commit",
      stage: "initial_state_committed",
      phase: "initial",
      binding: observed.receipt.binding,
      logicalTarget: record.checkpointDigest,
      invocationId,
      localAttemptIndex: 0,
      phaseSequence: 1,
      expectedStateRevision:
        expectedHead.status === "missing" ? { status: "missing" } : expectedHead.revision,
      receiptKind: "executed",
      observedAt: observed.receipt.observedAt,
      status: "committed",
      effectCertainty: "committed",
      result: observed.receipt.result,
    },
    digest,
  );
  if (executed.receiptType !== "initial_state_commit") {
    throw new TypeError("初回state commitの実行receipt種別が不正です");
  }
  return Object.freeze({ revision: written.commit.revision, receipt: executed });
}
