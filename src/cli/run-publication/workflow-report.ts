import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import { nodeContentDigestPort } from "../../infrastructure/tracking-run/content-digest.js";
import { readNotificationMessageState } from "../notification-message-state.js";
import { createNotificationSettlementPort } from "../notification-stage-runtime.js";
import { finalizeRun } from "../run-finalization.js";
import type { ReportWorkflowCliCommand } from "../command.js";
import type { RunPublicationAdapters } from "./contracts.js";

type WorkflowReportAdapters = Pick<
  RunPublicationAdapters,
  | "repositoryPath"
  | "loadConfig"
  | "createStateBranchAdapter"
  | "environment"
  | "discordHttpClient"
  | "diagnosticsRecorder"
  | "now"
>;

const fileNotFoundErrorSchema = z.object({ code: z.literal("ENOENT") });

async function optionalReceipt(
  adapters: WorkflowReportAdapters,
  path: string,
): Promise<ReturnType<typeof decodeReceipt> | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(resolve(adapters.repositoryPath, path));
  } catch (error: unknown) {
    if (fileNotFoundErrorSchema.safeParse(error).success) {
      return null;
    }
    throw error;
  }
  return decodeReceipt(bytes, nodeContentDigestPort);
}

/** 最終stateのreportをreceiptとexact commitから再観測する。 */
export async function finalizedWorkflowStateReport(
  adapters: WorkflowReportAdapters,
  command: ReportWorkflowCliCommand,
): Promise<
  Extract<Awaited<ReturnType<typeof finalizeRun>>, { kind: "finalized" }>["report"] | null
> {
  const [initial, settlement, finalReceipt] = await Promise.all([
    optionalReceipt(adapters, command.initialStateReceiptPath),
    optionalReceipt(adapters, command.settlementReceiptPath),
    optionalReceipt(adapters, command.finalizationReceiptPath),
  ]);
  if (initial == null || settlement == null) {
    if ((initial == null && settlement != null) || finalReceipt != null) {
      throw new TypeError("最終receiptに先行するstate receiptがありません");
    }
    return null;
  }
  if (
    initial.receiptType !== "initial_state_commit" ||
    initial.binding.bindingKind !== "checkpoint" ||
    settlement.receiptType !== "notification_settlement" ||
    (finalReceipt != null && finalReceipt.receiptType !== "run_finalization")
  ) {
    throw new TypeError("workflow reportのstate receipt種別が一致しません");
  }
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const adapter = adapters.createStateBranchAdapter();
  const head = await adapter.resolveHead(config.state.branch);
  if (head.status !== "present") {
    if (finalReceipt != null) {
      throw new TypeError("最終receiptに対応するstate branchがありません");
    }
    return null;
  }
  const current = await readNotificationMessageState(adapter, config.state, head.revision);
  if (
    current.transaction.marker.phase !== "run_finalized" ||
    current.transaction.marker.runId !== initial.binding.runId
  ) {
    if (finalReceipt != null) {
      throw new TypeError("最終receiptに対応するfinalized stateがありません");
    }
    return null;
  }
  const settled = await readNotificationMessageState(
    adapter,
    config.state,
    settlement.result.resultingStateRevision,
  );
  const observed = await finalizeRun(
    {
      record: settled.transaction.record,
      initialStateReceipt: initial,
      settlementReceipt: settlement,
    },
    createNotificationSettlementPort(
      adapters,
      config.state,
      current.snapshot.repositories,
      [],
      "recording",
    ),
  );
  if (observed.kind !== "finalized") {
    throw new TypeError("workflow reportのrun finalizationを観測できません");
  }
  if (
    finalReceipt != null &&
    (finalReceipt.operationId !== observed.receipt.operationId ||
      serializeCanonicalJson(finalReceipt.binding) !==
        serializeCanonicalJson(observed.receipt.binding) ||
      serializeCanonicalJson(finalReceipt.result) !==
        serializeCanonicalJson(observed.receipt.result))
  ) {
    throw new TypeError("workflow reportのfinalization receiptがexact stateと一致しません");
  }
  return observed.report;
}
