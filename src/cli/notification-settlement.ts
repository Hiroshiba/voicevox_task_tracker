import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import { serializeCanonicalJson } from "../canonical-json/value.js";
import {
  parseInitialPagesPublicationEvidence,
  type InitialPagesPublicationEvidence,
} from "../application/tracking-run/initial-pages-evidence.js";
import { verifyReceiptChain } from "../application/tracking-run/receipt-chain.js";
import type { ReceiptChainEvidence } from "../application/tracking-run/receipt-chain-schema.js";
import { parseReceipt } from "../application/tracking-run/receipt-codec.js";
import type { StateCommitReceiptEvidence } from "../application/tracking-run/observed-state-commit.js";
import type {
  InitialStateCommitReceipt,
  NotificationMessageReceipt,
  NotificationSettlementReceipt,
  PagesDeploymentReceipt,
  Receipt,
} from "../application/tracking-run/receipt-schema.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import { loadStateNotificationLedgers } from "../persistence/state-ledger-files.js";
import { StateBranchConflictError } from "../persistence/errors.js";
import { authorizeAdvanceAfterOrthogonalCommits } from "../persistence/state-orthogonal-advance.js";
import {
  parseDurablePublicationRecord,
  type DurablePublicationRecord,
} from "./durable-record-schema.js";
import { verifyInitialStateCommitReceiptAtRevision } from "./initial-pages-source.js";
import { commitNotificationSettlement } from "./notification-settlement-commit.js";
import {
  assertNextReceipt,
  receiptForSettlement,
  settledRevision,
} from "./notification-settlement-observation.js";
import {
  plannedNotificationMessages,
  assertInitialNotificationLedger,
} from "./notification-settlement-validation.js";
import {
  deliverNotificationMessage,
  type NotificationInitialPagesSource,
  type NotificationMessageDeliveryPort,
} from "./notification-message-delivery.js";
import { prepareNotificationMessageContext } from "./notification-message-context.js";
import { observeNotificationMessageDelivery } from "./notification-message-observation.js";
import { validatePagesSource } from "./notification-message-receipt.js";
import {
  readNotificationMessageState,
  type NotificationMessageState,
} from "./notification-message-state.js";
import { NotificationStructureError } from "./notification-structure-error.js";

/** 初回Pages公開後の固定outboxとstateを結合する通知settlement入力。 */
export type NotificationSettlementInput = Readonly<{
  record: DurablePublicationRecord;
  initialStateReceipt: InitialStateCommitReceipt;
  initialPages: NotificationInitialPagesSource;
  pagesReceipt: PagesDeploymentReceipt;
}>;

/** 通知の初回stateとPages artifact読込を同じ失敗境界へ渡す。 */
export type NotificationSettlementPreflightInput = Readonly<{
  record: DurablePublicationRecord;
  initialStateReceipt: InitialStateCommitReceipt;
  loadPages: () => Promise<Pick<NotificationSettlementInput, "initialPages" | "pagesReceipt">>;
}>;

/** 通知message、state、診断の副作用境界。 */
export type NotificationSettlementPort = NotificationMessageDeliveryPort;

/** settlementに先行する各messageのreceiptと観測証拠。 */
export type SettledMessageReceipt = Readonly<{
  receipt: NotificationMessageReceipt;
  evidence: ReceiptChainEvidence;
}>;

/** 後続finalizationまたは失敗処理へ渡す通知stage結果。 */
export type NotificationSettlementOutcome =
  | Readonly<{
      kind: "settled";
      receipt: NotificationSettlementReceipt;
      receiptEvidence: ReceiptChainEvidence;
      messageReceipts: readonly SettledMessageReceipt[];
      stateRevision: string;
      notificationCount: number;
    }>
  | Readonly<{
      kind: "manual_resolution_required";
      receipt: NotificationMessageReceipt;
      messageReceipts: readonly SettledMessageReceipt[];
      stateRevision: string;
    }>
  | Readonly<{
      kind: "state_unconfirmed";
      messageReceipts: readonly SettledMessageReceipt[];
      stateRevision: string;
      markerPhase: "initial_state_committed" | "notifications_in_progress";
      effectCertainty: "committed" | "no_effect" | "ambiguous";
      recoveryDisposition:
        "operator_conflict_resolution" | "manual_resolution_required" | "resume_from_receipt";
      lastReceipt?: Receipt;
      discordMessageId?: string;
    }>
  | Readonly<{
      kind: "conflict";
      messageReceipts: readonly SettledMessageReceipt[];
      observedHeadRevision: string;
    }>
  | Readonly<{
      kind: "structural_failure";
      messageReceipts: readonly SettledMessageReceipt[];
      stateRevision: string;
      markerPhase: "initial_state_committed" | "notifications_in_progress";
      lastReceipt?: Receipt;
      failedOperationEffectCertainty: "no_effect" | "committed";
      recoveryDisposition:
        "operator_conflict_resolution" | "manual_resolution_required" | "resume_from_receipt";
      cause: NotificationStructureError;
    }>;

/** 通知stageの失敗結果と元の診断をCLI境界へ渡す。 */
export class NotificationSettlementFailureError extends Error {
  public readonly outcome: Exclude<NotificationSettlementOutcome, { kind: "settled" }>;

  public constructor(outcome: Exclude<NotificationSettlementOutcome, { kind: "settled" }>) {
    super(`通知settlementを確定できません。状態: ${outcome.kind}`, {
      cause: outcome.kind === "structural_failure" ? outcome.cause : undefined,
    });
    this.name = "NotificationSettlementFailureError";
    this.outcome = outcome;
  }
}

interface NotificationSettlementProgress {
  messageReceipts: SettledMessageReceipt[];
  previousReceipt: Receipt | undefined;
}

function invalidPagesSource(cause: unknown): never {
  if (cause instanceof NotificationStructureError) {
    throw cause;
  }
  if (cause instanceof TypeError || cause instanceof ZodError) {
    throw new NotificationStructureError("通知settlementの初回Pages証拠が不正です", "no_effect", {
      cause,
    });
  }
  throw cause;
}

async function observeFailureState(
  input: Pick<NotificationSettlementInput, "record" | "initialStateReceipt">,
  port: NotificationSettlementPort,
  progress: NotificationSettlementProgress,
  effectCertainty: "no_effect" | "committed" | "ambiguous",
  cause: Error | undefined,
): Promise<
  Readonly<{
    stateRevision: string;
    markerPhase: "initial_state_committed" | "notifications_in_progress";
    recoveryDisposition:
      "operator_conflict_resolution" | "manual_resolution_required" | "resume_from_receipt";
  }>
> {
  const head = await port.adapter.resolveHead(port.configuration.branch);
  if (head.status !== "present") {
    throw new TypeError("通知構造エラー後のstate branchがありません", { cause });
  }
  const state = await readNotificationMessageState(port.adapter, port.configuration, head.revision);
  if (
    state.transaction.record.recordDigest !== input.record.recordDigest ||
    state.transaction.marker.runId !== input.record.runIdentity.runId ||
    (state.transaction.marker.phase !== "initial_state_committed" &&
      state.transaction.marker.phase !== "notifications_in_progress")
  ) {
    throw new TypeError("通知構造エラー後のstateが同じ保留runではありません", { cause });
  }
  const markerPhase = state.transaction.marker.phase;
  if (markerPhase === "initial_state_committed" && effectCertainty !== "no_effect") {
    throw new TypeError("通知の外部効果と初回markerの段階が一致しません", { cause });
  }
  let canResumeFromReceipt = false;
  if (progress.previousReceipt?.receiptType === "notification_message") {
    try {
      await authorizeAdvanceAfterOrthogonalCommits(
        port.adapter,
        port.configuration,
        progress.previousReceipt.result.ledgerStateRevision,
        head.revision,
      );
      canResumeFromReceipt = true;
    } catch (observationError: unknown) {
      if (!(observationError instanceof StateBranchConflictError)) {
        throw observationError;
      }
    }
  }
  const currentDeliveryId =
    state.transaction.marker.phase === "initial_state_committed"
      ? undefined
      : state.transaction.marker.lastMessageDeliveryId;
  const deliveryStarted = state.ledger.entries.some(
    (entry) => entry.status === "delivery_started" && entry.deliveryId === currentDeliveryId,
  );
  return {
    stateRevision: head.revision,
    markerPhase,
    recoveryDisposition:
      effectCertainty !== "no_effect" || deliveryStarted
        ? "manual_resolution_required"
        : markerPhase === "notifications_in_progress" && canResumeFromReceipt
          ? "resume_from_receipt"
          : "operator_conflict_resolution",
  };
}

async function structuralFailure(
  input: Pick<NotificationSettlementInput, "record" | "initialStateReceipt">,
  port: NotificationSettlementPort,
  progress: NotificationSettlementProgress,
  cause: NotificationStructureError,
): Promise<NotificationSettlementOutcome> {
  const observed = await observeFailureState(input, port, progress, cause.effectCertainty, cause);
  return {
    kind: "structural_failure",
    messageReceipts: progress.messageReceipts,
    ...observed,
    ...(progress.previousReceipt == null ? {} : { lastReceipt: progress.previousReceipt }),
    failedOperationEffectCertainty: cause.effectCertainty,
    cause,
  };
}

async function stateUnconfirmedFailure(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
  progress: NotificationSettlementProgress,
  effectCertainty: "no_effect" | "committed" | "ambiguous",
  discordMessageId: string | undefined,
): Promise<NotificationSettlementOutcome> {
  const observed = await observeFailureState(input, port, progress, effectCertainty, undefined);
  return {
    kind: "state_unconfirmed",
    messageReceipts: progress.messageReceipts,
    ...observed,
    effectCertainty,
    ...(progress.previousReceipt == null ? {} : { lastReceipt: progress.previousReceipt }),
    ...(discordMessageId == null ? {} : { discordMessageId }),
  };
}

function assertPagesReceipt(input: NotificationSettlementInput): void {
  const pages = parseReceipt(input.pagesReceipt, digest);
  const initial = parseReceipt(input.initialStateReceipt, digest);
  const evidence = parseInitialPagesPublicationEvidence(input.initialPages.evidence, digest);
  if (
    pages.receiptType !== "pages_deployment" ||
    initial.receiptType !== "initial_state_commit" ||
    pages.phase !== "initial" ||
    pages.effectCertainty !== "committed" ||
    pages.result == null ||
    pages.binding.bindingKind !== "checkpoint" ||
    serializeCanonicalJson(pages.binding) !== serializeCanonicalJson(initial.binding) ||
    pages.result.sourceStateRevision !== initial.result.resultingStateRevision ||
    pages.result.pageUrl !== evidence.pageUrl ||
    pages.operationId !== evidence.deploymentOperationId
  ) {
    throw new NotificationStructureError(
      "通知settlementの初回Pages receiptが永続runと一致しません",
      "no_effect",
    );
  }
  if (input.initialPages.kind === "published") {
    if (
      serializeCanonicalJson(pages) !==
        serializeCanonicalJson(input.initialPages.deploymentReceipt) ||
      pages.previousReceiptDigest !== input.initialPages.buildReceipt.receiptDigest ||
      pages.phaseSequence !== input.initialPages.buildReceipt.phaseSequence + 1
    ) {
      throw new NotificationStructureError(
        "通知settlementのPages成功receipt列が一致しません",
        "no_effect",
      );
    }
  } else if (
    pages.receiptKind !== "observed" ||
    pages.result.evidenceDigest !== evidence.evidenceDigest ||
    pages.result.observedSourceReceiptDigest !== evidence.deploymentReceiptDigest
  ) {
    throw new NotificationStructureError(
      "通知settlementのPages再観測receiptがstate証拠と一致しません",
      "no_effect",
    );
  }
}

function assertMessageChain(receipts: readonly SettledMessageReceipt[]): void {
  if (receipts.length > 0) {
    verifyReceiptChain(receipts, digest);
  }
}

async function assertObservedPagesReceipt(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
): Promise<void> {
  if (input.initialPages.kind !== "state") {
    return;
  }
  const revision = input.pagesReceipt.expectedStateRevision;
  if (typeof revision !== "string") {
    throw new NotificationStructureError(
      "再観測した初回Pages receiptにexact state revisionがありません",
      "no_effect",
    );
  }
  const state = await readNotificationMessageState(port.adapter, port.configuration, revision);
  const marker = state.transaction.marker;
  const evidence = state.transaction.initialPagesEvidence;
  if (
    marker.phase === "initial_state_committed" ||
    evidence == null ||
    serializeCanonicalJson(evidence) !== serializeCanonicalJson(input.initialPages.evidence)
  ) {
    throw new NotificationStructureError(
      "再観測した初回Pages receiptのexact state証拠が一致しません",
      "no_effect",
    );
  }
  verifyReceiptChain(
    [
      {
        receipt: input.pagesReceipt,
        evidence: {
          kind: "initial_pages_state",
          state: {
            exactStateRevision: revision,
            marker: {
              runId: marker.runId,
              checkpointDigest: marker.checkpointDigest,
              phase: marker.phase,
              initialPagesPublicationEvidenceDigest: marker.initialPagesPublicationEvidenceDigest,
              initialStateRevision: marker.initialStateRevision,
            },
            evidence,
          },
        },
      },
    ],
    digest,
  );
}

async function initialState(
  input: Pick<NotificationSettlementInput, "record" | "initialStateReceipt">,
  port: NotificationSettlementPort,
): Promise<
  Readonly<{
    state: NotificationMessageState;
    receiptEvidence: Extract<StateCommitReceiptEvidence, { receiptType: "initial_state_commit" }>;
  }>
> {
  const initialRevision = input.initialStateReceipt.result.resultingStateRevision;
  const receiptEvidence = await verifyInitialStateCommitReceiptAtRevision(
    port.adapter,
    port.configuration,
    input.initialStateReceipt,
    port.now().toISOString(),
  );
  const initial = await readNotificationMessageState(
    port.adapter,
    port.configuration,
    initialRevision,
  );
  const base = input.record.baseStateRevision;
  const previous = await loadStateNotificationLedgers(
    port.adapter,
    port.configuration,
    base.status === "missing"
      ? { status: "missing" }
      : { status: "present", revision: base.revision },
  );
  if (initial.transaction.record.recordDigest !== input.record.recordDigest) {
    throw new NotificationStructureError(
      "通知settlementの初回stateと永続recordが一致しません",
      "no_effect",
    );
  }
  assertInitialNotificationLedger(input.record, initial, previous);
  verifyReceiptChain(
    [
      {
        receipt: input.initialStateReceipt,
        evidence:
          input.initialStateReceipt.receiptKind === "observed"
            ? { kind: "state_commit", state: receiptEvidence }
            : { kind: "none" },
      },
    ],
    digest,
  );
  return { state: initial, receiptEvidence };
}

async function settleNotificationsChecked(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
  progress: NotificationSettlementProgress,
  initial: NotificationMessageState,
  initialReceiptEvidence: Extract<
    StateCommitReceiptEvidence,
    { receiptType: "initial_state_commit" }
  >,
): Promise<NotificationSettlementOutcome> {
  const record = parseDurablePublicationRecord(input.record, digest);
  if (record.recordDigest !== input.record.recordDigest) {
    throw new NotificationStructureError("通知settlementの永続recordが一致しません", "no_effect");
  }
  try {
    assertPagesReceipt(input);
    await assertObservedPagesReceipt(input, port);
    if (input.initialPages.kind === "published") {
      verifyReceiptChain(
        [
          {
            receipt: input.initialStateReceipt,
            evidence:
              input.initialStateReceipt.receiptKind === "observed"
                ? { kind: "state_commit", state: initialReceiptEvidence }
                : { kind: "none" },
          },
          { receipt: input.initialPages.buildReceipt, evidence: { kind: "none" } },
          { receipt: input.pagesReceipt, evidence: { kind: "none" } },
        ],
        digest,
      );
    }
  } catch (cause: unknown) {
    invalidPagesSource(cause);
  }
  progress.previousReceipt = input.pagesReceipt;
  const head = await port.adapter.resolveHead(port.configuration.branch);
  if (head.status !== "present") {
    throw new TypeError("通知settlementのstate branchがありません");
  }
  const current = await readNotificationMessageState(
    port.adapter,
    port.configuration,
    head.revision,
  );
  if (
    current.transaction.record.recordDigest !== record.recordDigest ||
    current.transaction.marker.runId !== record.runIdentity.runId
  ) {
    await port.recordDiagnostic(new TypeError("通知settlementのremote stateが別runへ進みました"));
    return { kind: "conflict", messageReceipts: [], observedHeadRevision: head.revision };
  }
  let evidence: InitialPagesPublicationEvidence;
  try {
    evidence = validatePagesSource(
      input.initialPages,
      input.initialStateReceipt,
      current.transaction.marker.phase === "initial_state_committed",
    );
  } catch (cause: unknown) {
    invalidPagesSource(cause);
  }
  if (
    current.transaction.marker.phase !== "initial_state_committed" &&
    serializeCanonicalJson(current.transaction.initialPagesEvidence) !==
      serializeCanonicalJson(evidence)
  ) {
    throw new NotificationStructureError(
      "通知settlementの保存済みPages証拠が入力と一致しません",
      "no_effect",
    );
  }
  const messages = plannedNotificationMessages(record, initial, evidence);
  for (let index = 0; index < messages.length; index += 1) {
    prepareNotificationMessageContext(record, initial.snapshot, initial.ledger, evidence, index);
  }
  const invocationId = randomUUID();
  const messageReceipts = progress.messageReceipts;
  let expectedRevision = input.initialStateReceipt.result.resultingStateRevision;
  let previousReceipt: Receipt = input.pagesReceipt;
  if (current.transaction.marker.phase === "notifications_settled") {
    const revision = await settledRevision(input, port, head.revision);
    for (let index = 0; index < messages.length; index += 1) {
      const observed = await observeNotificationMessageDelivery(
        {
          record,
          initialStateReceipt: input.initialStateReceipt,
          initialPages: input.initialPages,
          previousReceipt,
          expectedStateRevision: expectedRevision,
          messageIndex: index,
          invocationId,
          localAttemptIndex: index,
        },
        port.adapter,
        port.configuration,
        revision,
        port.now().toISOString(),
      );
      if (observed == null || observed.receipt.status === "ambiguous") {
        throw new TypeError("確定済みsettlementに未処理messageがあります");
      }
      assertNextReceipt(previousReceipt, observed.receipt, expectedRevision);
      const next = {
        receipt: observed.receipt,
        evidence: { kind: "notification_message_state", state: observed.evidence },
      } satisfies SettledMessageReceipt;
      assertMessageChain([...messageReceipts, next]);
      messageReceipts.push(next);
      previousReceipt = observed.receipt;
      progress.previousReceipt = observed.receipt;
      expectedRevision = observed.stateRevision;
    }
    assertMessageChain(messageReceipts);
    return receiptForSettlement(
      input,
      port,
      revision,
      expectedRevision,
      previousReceipt,
      messageReceipts,
      initial,
      messages,
      invocationId,
      false,
    );
  }
  if (
    current.transaction.marker.phase !== "initial_state_committed" &&
    current.transaction.marker.phase !== "notifications_in_progress"
  ) {
    await port.recordDiagnostic(
      new TypeError("通知settlementのremote stateが処理可能な段階ではありません"),
    );
    return { kind: "conflict", messageReceipts: [], observedHeadRevision: head.revision };
  }
  for (let index = 0; index < messages.length; index += 1) {
    const outcome = await deliverNotificationMessage(
      {
        record,
        initialStateReceipt: input.initialStateReceipt,
        initialPages: input.initialPages,
        previousReceipt,
        expectedStateRevision: expectedRevision,
        messageIndex: index,
        invocationId,
        localAttemptIndex: index,
      },
      port,
    );
    if (outcome.kind === "conflict") {
      return {
        kind: "conflict",
        messageReceipts,
        observedHeadRevision: outcome.observedHeadRevision,
      };
    }
    if (outcome.kind === "state_unconfirmed") {
      return stateUnconfirmedFailure(
        input,
        port,
        progress,
        outcome.effectCertainty,
        outcome.discordMessageId,
      );
    }
    assertNextReceipt(previousReceipt, outcome.receipt, expectedRevision);
    const next = { receipt: outcome.receipt, evidence: outcome.receiptEvidence };
    assertMessageChain([...messageReceipts, next]);
    messageReceipts.push(next);
    previousReceipt = outcome.receipt;
    progress.previousReceipt = outcome.receipt;
    expectedRevision = outcome.stateRevision;
    if (outcome.kind === "ambiguous") {
      return {
        kind: "manual_resolution_required",
        receipt: outcome.receipt,
        messageReceipts,
        stateRevision: outcome.stateRevision,
      };
    }
  }
  const committed = await commitNotificationSettlement(
    input,
    port,
    initial,
    messages,
    messageReceipts.map((entry) => entry.receipt),
    evidence,
    expectedRevision,
  );
  if (committed.kind === "conflict") {
    await port.recordDiagnostic(new TypeError("通知settlementのCASとremote stateが競合しました"));
    return {
      kind: "conflict",
      messageReceipts,
      observedHeadRevision: committed.observedHeadRevision,
    };
  }
  if (committed.kind === "state_unconfirmed") {
    await port.recordDiagnostic(new TypeError("通知settlementのCASをremoteで確定できません"));
    return stateUnconfirmedFailure(input, port, progress, "no_effect", undefined);
  }
  return receiptForSettlement(
    input,
    port,
    committed.revision,
    expectedRevision,
    previousReceipt,
    messageReceipts,
    initial,
    messages,
    invocationId,
    !committed.observed,
  );
}

/** 固定outboxを順に確定し、成功actionを単一のstate settlementへ進める。 */
export async function settleNotifications(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
): Promise<NotificationSettlementOutcome> {
  return settleNotificationsWithPreflight(
    {
      record: input.record,
      initialStateReceipt: input.initialStateReceipt,
      loadPages: () =>
        Promise.resolve({ initialPages: input.initialPages, pagesReceipt: input.pagesReceipt }),
    },
    port,
  );
}

/** Pages artifact読込を含めて通知の失敗を分類する。 */
export async function settleNotificationsWithPreflight(
  input: NotificationSettlementPreflightInput,
  port: NotificationSettlementPort,
): Promise<NotificationSettlementOutcome> {
  const progress: NotificationSettlementProgress = {
    messageReceipts: [],
    previousReceipt: undefined,
  };
  try {
    const initial = await initialState(input, port);
    progress.previousReceipt = input.initialStateReceipt;
    const pages = await input.loadPages();
    return await settleNotificationsChecked(
      { record: input.record, initialStateReceipt: input.initialStateReceipt, ...pages },
      port,
      progress,
      initial.state,
      initial.receiptEvidence,
    );
  } catch (cause: unknown) {
    if (!(cause instanceof NotificationStructureError)) {
      throw cause;
    }
    return structuralFailure(input, port, progress, cause);
  }
}
