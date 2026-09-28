import { z } from "zod";

import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import type { ContentDigestPort } from "./ports.js";
import { receiptSchema, type PagesDeploymentReceipt, type Receipt } from "./receipt-schema.js";
import {
  parseInitialPagesPublicationEvidence,
  type InitialPagesEvidenceState,
} from "./initial-pages-evidence.js";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const identityMask = {
  operationId: true,
  attemptId: true,
  receiptDigest: true,
  receiptId: true,
} satisfies Record<"operationId" | "attemptId" | "receiptDigest" | "receiptId", true>;
const draftSchema = z.union([
  receiptSchema.options[0].omit(identityMask),
  receiptSchema.options[1].omit(identityMask),
  receiptSchema.options[2].omit(identityMask),
  receiptSchema.options[3].omit(identityMask),
  receiptSchema.options[4].omit(identityMask),
  receiptSchema.options[5].omit(identityMask),
  receiptSchema.options[6].omit(identityMask),
  receiptSchema.options[7].omit(identityMask),
  receiptSchema.options[8].omit(identityMask),
]);

/** 同じ起動の一試行で確定した識別子以外のreceipt値。 */
export type ReceiptDraft = z.output<typeof draftSchema>;

function digestId(
  prefix: "operation" | "attempt" | "receipt",
  value: unknown,
  digest: ContentDigestPort,
): string {
  return `${prefix}:v1:${digest.sha256Utf8(serializeCanonicalJson(value)).slice("sha256:".length)}`;
}

function operationIdentity(receipt: ReceiptDraft | Receipt): object {
  const common = {
    bindingKind: receipt.binding.bindingKind,
    stage: receipt.stage,
    phase: receipt.phase,
    logicalTarget: receipt.logicalTarget,
  };
  switch (receipt.binding.bindingKind) {
    case "checkpoint":
      return { ...common, runId: receipt.binding.runId };
    case "run_pre_checkpoint_alert":
      return {
        ...common,
        runId: receipt.binding.runId,
        failedStage: receipt.binding.failedStage,
        failureArtifactDigest: receipt.binding.failureArtifactDigest,
      };
    case "state_bootstrap_alert":
      return {
        ...common,
        observedStateRevision: receipt.binding.observedStateRevision,
        observedMarkerFile: receipt.binding.observedMarkerFile,
        observedRecordFile: receipt.binding.observedRecordFile,
        failureArtifactDigest: receipt.binding.failureArtifactDigest,
      };
    case "invocation_pre_run_alert":
      return {
        ...common,
        invocationId: receipt.invocationId,
        failureArtifactDigest: receipt.binding.failureArtifactDigest,
      };
  }
}

function assertReceiptSemantics(receipt: Receipt): void {
  if (receipt.receiptType !== "operations_alert" && receipt.binding.bindingKind !== "checkpoint") {
    throw new TypeError("通常receiptにcheckpoint以外の結合は使えません");
  }
  if (
    receipt.previousReceiptDigest == null &&
    receipt.expectedStateRevision == null &&
    receipt.binding.bindingKind !== "invocation_pre_run_alert"
  ) {
    throw new TypeError("receiptに前receiptまたは期待state revisionが必要です");
  }
  if (
    (receipt.binding.bindingKind === "invocation_pre_run_alert" &&
      receipt.expectedStateRevision != null) ||
    (receipt.binding.bindingKind === "state_bootstrap_alert" &&
      receipt.expectedStateRevision !== receipt.binding.observedStateRevision) ||
    (receipt.binding.bindingKind === "run_pre_checkpoint_alert" &&
      receipt.expectedStateRevision !== receipt.binding.baseStateRevision)
  ) {
    throw new TypeError("checkpoint前の運用通知に存在しないstate revisionがあります");
  }
  if (receipt.receiptKind === "observed") {
    if (
      receipt.receiptType !== "pages_deployment" ||
      receipt.phase !== "initial" ||
      receipt.status !== "deployed" ||
      receipt.result?.observedSourceReceiptDigest == null ||
      receipt.result.evidenceDigest == null
    ) {
      throw new TypeError("observed receiptにはstateで裏付けた初回Pages証拠が必要です");
    }
  } else if (receipt.receiptType === "pages_deployment" && receipt.result != null) {
    if (
      receipt.result.observedSourceReceiptDigest != null ||
      receipt.result.evidenceDigest != null
    ) {
      throw new TypeError("Pagesの再観測証拠はobserved receiptだけに保持します");
    }
  }
  if (receipt.receiptKind === "not_required" && receipt.effectCertainty !== "no_effect") {
    throw new TypeError("不要なeffectを実行済みとして記録できません");
  }
  if (receipt.receiptKind === "superseded" && receipt.effectCertainty !== "no_effect") {
    throw new TypeError("新しいrunで無効になったeffectを実行済みとして記録できません");
  }
  if (receipt.receiptType === "pages_build") {
    if (
      (receipt.phase === "initial") !== (receipt.stage === "initial_pages_prepared") ||
      (receipt.status === "built") !== (receipt.result != null) ||
      (receipt.status === "built") !== (receipt.effectCertainty === "committed") ||
      (receipt.status === "not_required") !== (receipt.receiptKind === "not_required") ||
      (receipt.result != null && receipt.logicalTarget !== receipt.result.deploymentIntentDigest)
    ) {
      throw new TypeError("Pages build receiptの段階と結果が一致しません");
    }
  }
  if (receipt.receiptType === "pages_deployment") {
    if (
      (receipt.phase === "initial") !== (receipt.stage === "initial_pages_published") ||
      (receipt.status === "deployed" || receipt.status === "replayed_same_content") !==
        (receipt.result != null) ||
      (receipt.status === "deployed" || receipt.status === "replayed_same_content") !==
        (receipt.effectCertainty === "committed") ||
      (receipt.status === "not_required") !== (receipt.receiptKind === "not_required") ||
      (receipt.status === "superseded_by_newer_run") !== (receipt.receiptKind === "superseded") ||
      (receipt.status === "ambiguous") !== (receipt.effectCertainty === "ambiguous") ||
      (receipt.result != null && receipt.logicalTarget !== receipt.result.deploymentIntentDigest)
    ) {
      throw new TypeError("Pages deployment receiptの段階と結果が一致しません");
    }
  }
  if (receipt.receiptType === "notification_message") {
    if (
      (receipt.status === "sent") !== (receipt.effectCertainty === "committed") ||
      (receipt.status === "ambiguous") !== (receipt.effectCertainty === "ambiguous") ||
      (receipt.status === "sent") !== (receipt.result.discordMessageId != null)
    ) {
      throw new TypeError("通知message receiptの配送結果が一致しません");
    }
  }
  if (receipt.receiptType === "operations_alert") {
    if (
      (receipt.status === "sent") !== (receipt.effectCertainty === "committed") ||
      (receipt.status === "ambiguous") !== (receipt.effectCertainty === "ambiguous") ||
      (receipt.status === "sent") !== (receipt.result.discordMessageId != null)
    ) {
      throw new TypeError("運用通知receiptの送達結果が一致しません");
    }
  }
  if (
    (receipt.receiptType === "initial_state_commit" ||
      receipt.receiptType === "notification_settlement" ||
      receipt.receiptType === "manual_resolution" ||
      receipt.receiptType === "run_finalization") &&
    receipt.expectedStateRevision !== receipt.result.expectedTrackingStateRevision
  ) {
    throw new TypeError("state commit receiptの期待revisionが一致しません");
  }
  if (
    receipt.receiptType === "initial_state_commit" ||
    receipt.receiptType === "notification_settlement" ||
    receipt.receiptType === "run_finalization"
  ) {
    if (receipt.result.commitScope !== "tracking_run") {
      throw new TypeError("tracking commit receiptのscopeが一致しません");
    }
  }
  if (
    receipt.receiptType === "manual_resolution" &&
    receipt.result.commitScope !== "manual_resolution"
  ) {
    throw new TypeError("手動解決receiptのscopeが一致しません");
  }
  if (
    receipt.receiptKind === "not_required" &&
    receipt.receiptType !== "pages_build" &&
    receipt.receiptType !== "pages_deployment"
  ) {
    throw new TypeError("このreceiptは不要判定を持てません");
  }
  if (receipt.receiptKind === "superseded" && receipt.receiptType !== "pages_deployment") {
    throw new TypeError("このreceiptは新runによる無効化を持てません");
  }
}

/** 論理効果、起動内試行、canonical payloadからreceiptを発行する。 */
export function createReceipt(value: ReceiptDraft, digest: ContentDigestPort): Receipt {
  if (value.receiptKind === "observed") {
    throw new TypeError("observed receiptはstate証拠専用の生成関数から発行してください");
  }
  return sealReceipt(value, digest);
}

/** state evidence照合済みのobserved receiptを発行する。 */
function sealObservedReceipt(value: ReceiptDraft, digest: ContentDigestPort): Receipt {
  if (value.receiptKind !== "observed") {
    throw new TypeError("observed receipt以外は通常の生成関数を使用してください");
  }
  return sealReceipt(value, digest);
}

function sealReceipt(value: ReceiptDraft, digest: ContentDigestPort): Receipt {
  const draft = draftSchema.parse(value);
  const operationId = digestId("operation", operationIdentity(draft), digest);
  const attemptId = digestId(
    "attempt",
    { operationId, invocationId: draft.invocationId, localAttemptIndex: draft.localAttemptIndex },
    digest,
  );
  const payload = { ...draft, operationId, attemptId };
  const receiptDigest = digest.sha256Utf8(serializeCanonicalJson(payload));
  const receipt = receiptSchema.parse({
    ...payload,
    receiptDigest,
    receiptId: digestId("receipt", { operationId, attemptId, receiptDigest }, digest),
  });
  assertReceiptSemantics(receipt);
  return receipt;
}

/** receiptのshape、識別子、payload digestを再検証する。 */
export function parseReceipt(value: unknown, digest: ContentDigestPort): Receipt {
  const receipt = receiptSchema.parse(value);
  assertReceiptSemantics(receipt);
  const { receiptId, receiptDigest, ...payload } = receipt;
  if (
    receipt.operationId !== digestId("operation", operationIdentity(receipt), digest) ||
    receipt.attemptId !==
      digestId(
        "attempt",
        {
          operationId: receipt.operationId,
          invocationId: receipt.invocationId,
          localAttemptIndex: receipt.localAttemptIndex,
        },
        digest,
      ) ||
    receiptDigest !== digest.sha256Utf8(serializeCanonicalJson(payload)) ||
    receiptId !==
      digestId(
        "receipt",
        { operationId: receipt.operationId, attemptId: receipt.attemptId, receiptDigest },
        digest,
      )
  ) {
    throw new TypeError("receiptの識別子またはdigestが内容と一致しません");
  }
  return receipt;
}

/** 末尾改行付きcanonical JSONからreceiptを読む。 */
export function decodeReceipt(bytes: Uint8Array, digest: ContentDigestPort): Receipt {
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new TypeError("receiptが許容するbyte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("receiptがcanonical JSONではありません");
  }
  return parseReceipt(raw, digest);
}

/** receiptを末尾改行付きcanonical JSONへ保存する。 */
export function encodeReceipt(value: Receipt, digest: ContentDigestPort): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJsonLine(parseReceipt(value, digest)));
}

/** exact stateに保存済みの証拠だけから新しい観測試行を作る。 */
export function observeInitialPagesDeployment(
  input: Readonly<{
    state: InitialPagesEvidenceState;
    binding: Extract<PagesDeploymentReceipt["binding"], { bindingKind: "checkpoint" }>;
    invocationId: string;
    localAttemptIndex: number;
    phaseSequence: number;
    previousReceiptDigest: string;
    observedAt: string;
  }>,
  digest: ContentDigestPort,
): PagesDeploymentReceipt {
  const evidence = parseInitialPagesPublicationEvidence(input.state.evidence, digest);
  if (
    input.state.marker.initialPagesPublicationEvidenceDigest !== evidence.evidenceDigest ||
    input.state.marker.runId !== evidence.runId ||
    input.state.marker.checkpointDigest !== evidence.checkpointDigest ||
    input.state.marker.initialStateRevision !== evidence.sourceStateRevision ||
    input.binding.runId !== evidence.runId ||
    input.binding.checkpointDigest !== evidence.checkpointDigest
  ) {
    throw new TypeError("exact stateのmarkerと初回Pages証拠が一致しません");
  }
  const observed = sealObservedReceipt(
    {
      schemaVersion: 1,
      receiptType: "pages_deployment",
      stage: "initial_pages_published",
      phase: "initial",
      binding: input.binding,
      logicalTarget: evidence.deploymentIntentDigest,
      invocationId: input.invocationId,
      localAttemptIndex: input.localAttemptIndex,
      phaseSequence: input.phaseSequence,
      previousReceiptDigest: input.previousReceiptDigest,
      expectedStateRevision: input.state.exactStateRevision,
      receiptKind: "observed",
      observedAt: input.observedAt,
      ...(evidence.effectOccurredAt == null ? {} : { effectOccurredAt: evidence.effectOccurredAt }),
      status: "deployed",
      effectCertainty: "committed",
      result: {
        deploymentIntentDigest: evidence.deploymentIntentDigest,
        pagesContentDigest: evidence.pagesContentDigest,
        sourceStateRevision: evidence.sourceStateRevision,
        pageUrl: evidence.pageUrl,
        externalReference: evidence.externalReference,
        observedSourceReceiptDigest: evidence.deploymentReceiptDigest,
        evidenceDigest: evidence.evidenceDigest,
      },
    },
    digest,
  );
  if (
    observed.receiptType !== "pages_deployment" ||
    observed.operationId !== evidence.deploymentOperationId
  ) {
    throw new TypeError("再観測したPages operation IDが保存証拠と一致しません");
  }
  return observed;
}
