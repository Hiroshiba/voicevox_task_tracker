import { hashCanonicalJson } from "../../../canonical-json/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementApplicationsSchema,
} from "../../../domain/ai-analysis-elements.js";
import type {
  AiAnalysisDependency,
  TrackedItemAiDependencies,
} from "../../../domain/ai-analysis-dependencies.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
} from "../../../domain/types.js";
import {
  createFinalGraphProjection,
  type FinalGraphProjectionInput,
} from "../../../graph/final-graph-projection.js";
import { PublicRepositoryAllowlist } from "../../../github/public-repository-allowlist.js";
import {
  createEmptyStateNotificationLedger,
  serializeStateNotificationLedger,
} from "../../../persistence/state-documents.js";
import {
  createStateSnapshot,
  serializeStateSnapshot,
  type StateSnapshot,
} from "../../../persistence/snapshot-v23.js";
import type { SnapshotCollectionItem } from "../../../persistence/snapshot-contracts.js";

import { SANDBOX_FIXED_SOURCE_DATASET } from "./dataset.js";
import { createSandboxEnumeratedItem } from "./items.js";

const dataset = SANDBOX_FIXED_SOURCE_DATASET;
const seedObservedAt = createUtcIsoDateTime("2026-07-31T23:59:00.000Z");
const repositoryId = createGitHubRepositoryId(dataset.repository.nodeId);
const applications = aiAnalysisElementApplicationsSchema.parse(
  Object.fromEntries(
    AI_ANALYSIS_ELEMENTS.map((element) => [element, { status: "deterministic_fallback" }]),
  ),
);
const dependency: AiAnalysisDependency = Object.freeze({ status: "not_dependent" });
const dependencies: TrackedItemAiDependencies = Object.freeze({
  status: dependency,
  waitingOn: dependency,
  nextAction: dependency,
  primaryWaitingOn: dependency,
  confidence: dependency,
  evidence: dependency,
  uncertainties: dependency,
  deadline: dependency,
  deadlineLevel: dependency,
  lastProgressAt: dependency,
  stallSince: dependency,
  severity: dependency,
  downstreamImpact: dependency,
  importance: dependency,
  attention: dependency,
  blockers: dependency,
  relationSet: dependency,
});
const aiAnalysis: TrackedItemAiAnalysis = Object.freeze({
  origin: "current",
  status: "not_required",
  elements: Object.freeze({}),
  adoptedElements: Object.freeze({}),
  retainedElements: Object.freeze({}),
  applications,
});
const author: StateSnapshot["items"][number]["author"] = Object.freeze({
  status: "identified",
  actor: Object.freeze({
    type: "bot",
    nodeId: createGitHubNodeId("U_sandbox_strict_zero_bot"),
    login: "strict-zero-fixture[bot]",
  }),
});
const emptyWaitingOn: readonly [] = Object.freeze([]);

function createSeedSnapshot(): StateSnapshot {
  const repository = PublicRepositoryAllowlist.create([
    {
      id: repositoryId,
      owner: dataset.organization,
      name: dataset.repository.name,
      visibility: dataset.repository.visibility,
      archived: dataset.repository.archived,
      disabled: dataset.repository.disabled,
      observedAt: seedObservedAt,
    },
  ]).repositories[0];
  if (repository == null) {
    throw new TypeError("固定sourceの公開repositoryがありません");
  }
  const enumerated = dataset.items.map((item) =>
    createSandboxEnumeratedItem(repository, item, seedObservedAt),
  );
  const trackedItems: StateSnapshot["items"] = dataset.items.map((item, index) => {
    const observed = enumerated[index];
    if (observed == null) {
      throw new TypeError("固定sourceの合成項目がありません");
    }
    const terminal = item.type === "issue";
    const activityAt = terminal ? item.closedAt : item.commentAt;
    const common: Omit<StateSnapshot["items"][number], "status" | "waitingOn"> = {
      nodeId: observed.nodeId,
      type: observed.type,
      repositoryId,
      displayReference: observed.displayReference,
      number: observed.number,
      url: observed.url,
      title: observed.title,
      importance: Object.freeze({ score: 0, level: "low", factors: Object.freeze([]) }),
      attention: Object.freeze({ score: 0, level: "low" }),
      importanceAssessment: Object.freeze({ status: "not_available" }),
      deadlineAssessment: Object.freeze({ status: "not_available" }),
      author,
      latestEventActor: Object.freeze({ status: "absent" }),
      state: observed.state,
      notificationClass: "standard",
      primaryWaitingOn: Object.freeze({
        index: "not_applicable",
        selectionReason: "待機対象なし",
      }),
      nextAction: terminal ? "終了済み" : "自動確認を待つ",
      createdAt: observed.createdAt,
      githubUpdatedAt: observed.updatedAt,
      lastHumanActivityAt: activityAt,
      lastProgressAt: activityAt,
      statusSince: activityAt,
      ownerSince: activityAt,
      stallSince: activityAt,
      observedAt: seedObservedAt,
      labels: Object.freeze([]),
      assignees: Object.freeze([]),
      reviewState: terminal ? "not_applicable" : "not_requested",
      checkState: terminal ? "not_applicable" : "pending",
      aiAnalysis,
      aiDependencies: dependencies,
      personalReminderCauses: Object.freeze([]),
      personalReminderCausePlanning: terminal
        ? Object.freeze({
            status: "excluded",
            planningVersion: "personal-reminder-planning-v2",
            reason: "terminal_without_cause",
          })
        : Object.freeze({
            status: "pending",
            planningVersion: "personal-reminder-planning-v2",
          }),
      inputEvents: Object.freeze([]),
      confidence: 1,
      evidence: Object.freeze([]),
      uncertainties: Object.freeze([]),
      severity: "none",
      severityContext: Object.freeze({
        waitClass: terminal ? "notApplicable" : "automation",
        decisionBasis: "deterministic",
      }),
    };
    return terminal
      ? Object.freeze({ ...common, status: "terminal_completed", waitingOn: emptyWaitingOn })
      : Object.freeze({ ...common, status: "waiting_for_automation", waitingOn: emptyWaitingOn });
  });
  const collectionItems: readonly SnapshotCollectionItem[] = dataset.items.map((item, index) => {
    const observed = enumerated[index];
    if (observed == null) {
      throw new TypeError("固定sourceの合成項目がありません");
    }
    const common: Omit<SnapshotCollectionItem, "state" | "terminalAt"> = {
      freshness: "fresh",
      nodeId: observed.nodeId,
      repositoryId: repository.id,
      itemFingerprint: observed.itemFingerprint,
      analysisPlanFingerprint: Object.freeze({
        status: "unplanned",
        reason: "detail_required",
      }),
      aiAnalysis,
      observedAt: seedObservedAt,
    };
    return item.type === "issue"
      ? Object.freeze({ ...common, state: "closed", terminalAt: item.closedAt })
      : Object.freeze({ ...common, state: "open", terminalAt: null });
  });
  const projection = createFinalGraphProjection({
    evaluatedAt: seedObservedAt,
    timezone: "Asia/Tokyo",
    items: trackedItems.map((item): FinalGraphProjectionInput["items"][number] => ({
      ...item,
      deadlineLevel: "none",
    })),
    staleRepositoryIds: new Set(),
    relations: [],
    effectiveStateByNodeId: trackedItems.map((item) => [item.nodeId, item.state]),
    analysis: {
      dependencyCycles: [],
      actionableFrontier: trackedItems
        .filter((item) => item.state === "open")
        .map((item) => item.nodeId),
      downstreamImpacts: trackedItems.map((item) => ({
        nodeId: item.nodeId,
        openNodeCount: 0,
        repositoryCount: 0,
      })),
    },
  });
  const seedRunId = `tracker-run:${hashCanonicalJson({ kind: "sandbox_fixed_source_seed", dataset }).slice("sha256:".length)}`;
  return createStateSnapshot({
    schemaVersion: "23",
    generatedAt: seedObservedAt,
    trackingStartAt: { status: "not_fixed" },
    ai: { enabled: true, available: true, degraded: false },
    collection: {
      repositories: [
        { repositoryId: repository.id, successfulAt: seedObservedAt, items: collectionItems },
      ],
    },
    repositories: [{ ...repository, freshness: "fresh" }],
    items: trackedItems,
    graphNodeStateObservations: [],
    externalReferences: [],
    verifiedExternalReferences: [],
    relations: [],
    finalGraphProjection: projection,
    finalGraphProjectionDigest: hashCanonicalJson(projection),
    run: { id: seedRunId, status: "success", complete: true },
  });
}

/** 固定sourceの公開合成4件を現行state形式のseedへ直列化する。 */
export function createSandboxFixedSourceSeed(): Readonly<{
  snapshot: string;
  notificationLedger: string;
}> {
  return Object.freeze({
    snapshot: serializeStateSnapshot(createSeedSnapshot()),
    notificationLedger: serializeStateNotificationLedger(createEmptyStateNotificationLedger()),
  });
}
