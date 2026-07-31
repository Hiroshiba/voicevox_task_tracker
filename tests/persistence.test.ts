import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createAiCacheEntry,
  createAiCacheKey,
  hashCanonicalJson,
  type AiCacheEntry,
} from "../src/codex/index.js";
import {
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type Repository,
  type Status,
  type WaitingOnKind,
  type WaitingOnRole,
} from "../src/domain/index.js";
import {
  GitStateBranchAdapter,
  MemoryStateBranchAdapter,
  StateBranchCommitError,
  StatePersistenceSession,
  StatePublicSafetyError,
  createEmptyStateNotificationLedger,
  createStateNotificationLedger,
  createStateRunReport,
  createStateSnapshot,
  serializeCanonicalJson,
  serializeStateSnapshot,
  type StateNotificationLedger,
  type StatePersistenceConfiguration,
  type StateRunReport,
  type StateSnapshot,
} from "../src/persistence/index.js";
import { assertNonNullable } from "../src/util/index.js";

const execFileAsync = promisify(execFile);
const fixedTrackingStartAt = "2026-07-30T23:00:00.000Z";
const fixedItemAt = "2026-07-30T23:30:00.000Z";
const publicRepositoryId = "R_PUBLIC";
const privateRepositoryId = "R_PRIVATE_SENTINEL";
const itemNodeId = "I_TRACKED";
const stateConfiguration = Object.freeze({
  branch: "tracker-state",
  snapshotPath: "state/snapshot.json",
  historyDirectory: "state/history",
  aiCacheDirectory: "state/ai-cache",
  notificationLedgerPath: "state/notification-ledger.json",
  runReportsDirectory: "state/run-reports",
  canonicalJson: true,
}) satisfies StatePersistenceConfiguration;

type ResponsibilityFixture = Readonly<{
  status: Status;
  kind: WaitingOnKind;
  candidateId: string;
  role: WaitingOnRole;
}>;

type EdgeFixture =
  | Readonly<{
      status: "absent";
    }>
  | Readonly<{
      status: "active";
    }>
  | Readonly<{
      status: "inactive";
    }>;

type SnapshotFixtureOptions = Readonly<{
  runId: string;
  generatedAt: string;
  repositoryIds: readonly string[];
  responsibility: ResponsibilityFixture;
  severity: "none" | "watch" | "urgent" | "critical";
  edge: EdgeFixture;
}>;

function createRepository(id: string, visibility: "public" | "private" | "internal"): Repository {
  return Object.freeze({
    id: createGitHubRepositoryId(id),
    owner: "VOICEVOX",
    name: id.toLowerCase(),
    visibility,
    archived: false,
    disabled: false,
    observedAt: createUtcIsoDateTime(fixedItemAt),
  });
}

function createRepositoryInventory(includePrivate: boolean): readonly Repository[] {
  const repositories = [createRepository(publicRepositoryId, "public")];
  if (includePrivate) {
    repositories.push(createRepository(privateRepositoryId, "private"));
  }
  return Object.freeze(repositories);
}

function createRelations(edge: EdgeFixture): readonly unknown[] {
  if (edge.status === "absent") {
    return [];
  }
  const common = {
    id: "relation:blocker",
    fromNodeId: "I_BLOCKER",
    toNodeId: itemNodeId,
    type: "blocks",
    provenance: "native",
    confidence: 1,
    evidence: [
      {
        sourceId: "fixture:relation",
        supports: "relation",
        summary: "native dependency",
      },
    ],
    firstSeenAt: fixedItemAt,
    lastConfirmedAt: fixedItemAt,
  };
  if (edge.status === "active") {
    return [
      {
        ...common,
        active: true,
      },
    ];
  }
  return [
    {
      ...common,
      active: false,
      removedAt: fixedItemAt,
    },
  ];
}

function createSnapshot(options: SnapshotFixtureOptions): StateSnapshot {
  return createStateSnapshot({
    schemaVersion: "1",
    generatedAt: options.generatedAt,
    trackingStartAt: fixedTrackingStartAt,
    repositories: options.repositoryIds.map((repositoryId) => ({
      id: repositoryId,
      owner: "VOICEVOX",
      name: repositoryId.toLowerCase(),
      visibility: "public",
      archived: false,
      disabled: false,
      observedAt: fixedItemAt,
    })),
    items: [
      {
        nodeId: itemNodeId,
        type: "issue",
        repositoryId: publicRepositoryId,
        displayReference: "VOICEVOX/example#1",
        number: 1,
        url: "https://github.com/VOICEVOX/example/issues/1",
        title: "追跡対象",
        state: "open",
        status: options.responsibility.status,
        waitingOn: [
          {
            kind: options.responsibility.kind,
            candidateId: options.responsibility.candidateId,
            role: options.responsibility.role,
            reasonSummary: "次の対応待ちです",
            sourceIds: ["fixture:owner"],
            confidence: 1,
          },
        ],
        nextAction: "次の担当が対応する",
        createdAt: fixedItemAt,
        githubUpdatedAt: fixedItemAt,
        lastHumanActivityAt: fixedItemAt,
        lastProgressAt: fixedItemAt,
        statusSince: fixedItemAt,
        ownerSince: fixedItemAt,
        stallSince: fixedItemAt,
        observedAt: fixedItemAt,
        labels: ["優先度：高"],
        assignees: [],
        reviewState: "not_applicable",
        checkState: "not_applicable",
        confidence: 1,
        evidence: [
          {
            sourceId: "fixture:owner",
            supports: "waiting_on",
            summary: "fixtureの責務です",
          },
        ],
        uncertainties: [],
        severity: options.severity,
      },
    ],
    relations: createRelations(options.edge),
    run: {
      id: options.runId,
      status: "success",
      complete: true,
    },
  });
}

function subtractMinutes(value: string, minutes: number): string {
  return new Date(Date.parse(value) - minutes * 60_000).toISOString();
}

function createRunReport(
  snapshot: StateSnapshot,
  date: string,
  diagnostics: readonly string[],
): StateRunReport {
  return createStateRunReport({
    schemaVersion: "1",
    runId: snapshot.run.id,
    date,
    status: snapshot.run.status,
    complete: true,
    scheduledFor: subtractMinutes(snapshot.generatedAt, 10),
    startedAt: subtractMinutes(snapshot.generatedAt, 5),
    finishedAt: snapshot.generatedAt,
    metrics: {
      repositoryCount: snapshot.repositories.length,
      itemCount: snapshot.items.length,
      changedItemCount: 1,
      activeEdgeCount: snapshot.relations.filter((relation) => relation.active).length,
      aiCallCount: 0,
      aiCacheHitCount: 0,
      estimatedInputTokens: 0,
      githubApiRemaining: 5000,
      staleRepositoryCount: 0,
      notificationCount: 0,
      durationMilliseconds: 300_000,
    },
    diagnostics,
  });
}

function createSentLedger(cooldownUntil: string): StateNotificationLedger {
  return createStateNotificationLedger({
    schemaVersion: "1",
    entries: [
      {
        notificationKey: "notification:tracked:overdue",
        itemNodeId,
        reasonCode: "triage_overdue",
        severity: "urgent",
        reservedAt: fixedItemAt,
        cooldownUntil,
        status: "sent",
        sentAt: fixedItemAt,
        discordMessageId: "discord-message-1",
      },
    ],
  });
}

function createCacheEntry(): AiCacheEntry {
  const inputHash = hashCanonicalJson({
    input: "fixture",
  });
  const cacheKey = createAiCacheKey({
    model: "codex-model",
    backendVersion: "codex-cli-1",
    promptVersion: "prompt-v1",
    schemaVersion: "schema-v1",
    inputHash,
  });
  const output = {
    result: "cached",
  };
  return createAiCacheEntry({
    cacheKey,
    sourceHash: hashCanonicalJson({
      source: "fixture",
    }),
    metadata: {
      deterministicRulesVersion: "rules-v1",
      model: "codex-model",
      backendVersion: "codex-cli-1",
      promptVersion: "prompt-v1",
      schemaVersion: "schema-v1",
      inputHash,
      outputHash: hashCanonicalJson(output),
      executedAt: fixedItemAt,
    },
    output,
  });
}

function snapshotWithoutVolatileFields(snapshot: StateSnapshot): unknown {
  return {
    schemaVersion: snapshot.schemaVersion,
    trackingStartAt: snapshot.trackingStartAt,
    repositories: snapshot.repositories,
    items: snapshot.items,
    relations: snapshot.relations,
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("期待したエラーが発生しませんでした");
}

async function readGitOutput(
  repositoryPath: string,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", ["-C", repositoryPath, ...arguments_], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

describe("state canonical JSON", () => {
  it("キーと集合配列の入力順に依存せず同じbyte列を生成する", () => {
    const left = createSnapshot({
      runId: "run-canonical",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: ["R_SECOND", publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "active",
      },
    });
    const right = createSnapshot({
      runId: "run-canonical",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId, "R_SECOND"],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "active",
      },
    });

    expect(serializeStateSnapshot(left)).toBe(serializeStateSnapshot(right));
    expect(
      serializeCanonicalJson({
        outer: {
          z: 1,
          a: 2,
        },
      }),
    ).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("runごとのvolatile fieldを除けば同じ入力のbyte列が一致する", () => {
    const first = createSnapshot({
      runId: "run-volatile-1",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const second = createSnapshot({
      runId: "run-volatile-2",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });

    expect(serializeCanonicalJson(snapshotWithoutVolatileFields(first))).toBe(
      serializeCanonicalJson(snapshotWithoutVolatileFields(second)),
    );
  });
});

describe("メモリstate branch transaction", () => {
  it("初回はorphan branchを作成し、以後は同じbranchへcommitする", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const firstSnapshot = createSnapshot({
      runId: "run-bootstrap",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const firstSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    const first = await firstSession.persist({
      snapshot: firstSnapshot,
      notificationLedger: createEmptyStateNotificationLedger(),
      runReport: createRunReport(firstSnapshot, "2026-07-31", []),
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [],
    });

    expect(first.branchCreated).toBe(true);
    expect(adapter.readParent(first.revision)).toEqual({
      status: "missing",
    });

    const secondSnapshot = createSnapshot({
      runId: "run-next-day",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_review",
        kind: "team",
        candidateId: "team:reviewers",
        role: "reviewer",
      },
      severity: "urgent",
      edge: {
        status: "active",
      },
    });
    const secondSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    const second = await secondSession.persist({
      snapshot: secondSnapshot,
      notificationLedger: createEmptyStateNotificationLedger(),
      runReport: createRunReport(secondSnapshot, "2026-08-01", []),
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [],
    });

    expect(second.branchCreated).toBe(false);
    expect(adapter.readParent(second.revision)).toEqual({
      status: "present",
      revision: first.revision,
    });
    expect(second.updatedPaths).toEqual(
      expect.arrayContaining([
        "state/snapshot.json",
        "state/history/2026-08-01.jsonl",
        "state/notification-ledger.json",
        "state/run-reports/2026-08-01.json",
      ]),
    );
  });

  it("ref更新前の失敗でlast good commitとsnapshotを変えない", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const firstSnapshot = createSnapshot({
      runId: "run-last-good",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const firstSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    await firstSession.persist({
      snapshot: firstSnapshot,
      notificationLedger: createEmptyStateNotificationLedger(),
      runReport: createRunReport(firstSnapshot, "2026-07-31", []),
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [],
    });
    const headBefore = await adapter.resolveHead("tracker-state");
    const filesBefore = await adapter.readBranchFiles("tracker-state");
    const snapshotBefore = filesBefore.get(stateConfiguration.snapshotPath);
    assertNonNullable(snapshotBefore, "last good snapshotがありません");

    const failedSnapshot = createSnapshot({
      runId: "run-failed",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_review",
        kind: "team",
        candidateId: "team:reviewers",
        role: "reviewer",
      },
      severity: "urgent",
      edge: {
        status: "active",
      },
    });
    const failedSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    adapter.failNextCommit(new Error("fixture failure"));
    await expect(
      failedSession.persist({
        snapshot: failedSnapshot,
        notificationLedger: createEmptyStateNotificationLedger(),
        runReport: createRunReport(failedSnapshot, "2026-08-01", []),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [],
      }),
    ).rejects.toThrow(StateBranchCommitError);

    const headAfter = await adapter.resolveHead("tracker-state");
    const filesAfter = await adapter.readBranchFiles("tracker-state");
    const snapshotAfter = filesAfter.get(stateConfiguration.snapshotPath);
    assertNonNullable(snapshotAfter, "失敗後のlast good snapshotがありません");
    expect(headAfter).toEqual(headBefore);
    expect(snapshotAfter).toEqual(snapshotBefore);
  });

  it("private sentinelを独立allowlist検証で拒否してlast goodを維持する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const goodSnapshot = createSnapshot({
      runId: "run-public",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const goodSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    await goodSession.persist({
      snapshot: goodSnapshot,
      notificationLedger: createEmptyStateNotificationLedger(),
      runReport: createRunReport(goodSnapshot, "2026-07-31", []),
      repositoryInventory: createRepositoryInventory(true),
      knownSecrets: [],
    });
    const lastGoodHead = await adapter.resolveHead("tracker-state");

    const privateSnapshot = createSnapshot({
      runId: "run-private",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId, privateRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "urgent",
      edge: {
        status: "absent",
      },
    });
    const privateSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    await expect(
      privateSession.persist({
        snapshot: privateSnapshot,
        notificationLedger: createEmptyStateNotificationLedger(),
        runReport: createRunReport(privateSnapshot, "2026-08-01", []),
        repositoryInventory: createRepositoryInventory(true),
        knownSecrets: [],
      }),
    ).rejects.toThrow(StatePublicSafetyError);

    expect(await adapter.resolveHead("tracker-state")).toEqual(lastGoodHead);
  });

  it("secret patternを拒否し、エラーにもsecret値を含めない", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const snapshot = createSnapshot({
      runId: "run-secret",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const token = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789";
    const session = await StatePersistenceSession.open(adapter, stateConfiguration);
    const error = await captureError(
      session.persist({
        snapshot,
        notificationLedger: createEmptyStateNotificationLedger(),
        runReport: createRunReport(snapshot, "2026-07-31", [`token=${token}`]),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [token],
      }),
    );

    expect(error).toBeInstanceOf(StatePublicSafetyError);
    expect(error.message).not.toContain(token);
    expect(await adapter.resolveHead("tracker-state")).toEqual({
      status: "missing",
    });
  });

  it("AI cache内の不要な本文全文フィールドを拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const snapshot = createSnapshot({
      runId: "run-full-content",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const session = await StatePersistenceSession.open(adapter, stateConfiguration);
    const inputHash = hashCanonicalJson({
      input: "full-content",
    });
    const cacheKey = createAiCacheKey({
      model: "codex-model",
      backendVersion: "codex-cli-1",
      promptVersion: "prompt-v1",
      schemaVersion: "schema-v1",
      inputHash,
    });
    const output = {
      body: "保存してはいけない本文です",
    };
    await session.aiCache.write(
      createAiCacheEntry({
        cacheKey,
        sourceHash: hashCanonicalJson({
          source: "fixture",
        }),
        metadata: {
          deterministicRulesVersion: "rules-v1",
          model: "codex-model",
          backendVersion: "codex-cli-1",
          promptVersion: "prompt-v1",
          schemaVersion: "schema-v1",
          inputHash,
          outputHash: hashCanonicalJson(output),
          executedAt: fixedItemAt,
        },
        output,
      }),
    );

    await expect(
      session.persist({
        snapshot,
        notificationLedger: createEmptyStateNotificationLedger(),
        runReport: createRunReport(snapshot, "2026-07-31", []),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [],
      }),
    ).rejects.toThrow(StatePublicSafetyError);
    expect(await adapter.resolveHead("tracker-state")).toEqual({
      status: "missing",
    });
  });

  it("runnerを破棄してもAI cache hitと通知cooldownを読み戻す", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const snapshot = createSnapshot({
      runId: "run-cache-ledger",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "urgent",
      edge: {
        status: "absent",
      },
    });
    const cacheEntry = createCacheEntry();
    const cooldownUntil = "2026-08-03T00:00:00.000Z";
    const firstSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    await firstSession.aiCache.write(cacheEntry);
    await firstSession.persist({
      snapshot,
      notificationLedger: createSentLedger(cooldownUntil),
      runReport: createRunReport(snapshot, "2026-07-31", []),
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [],
    });

    const restartedSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    const cacheResult = await restartedSession.aiCache.read(cacheEntry.cacheKey);
    const ledger = await restartedSession.loadNotificationLedger();

    expect(cacheResult).toMatchObject({
      status: "hit",
      entry: {
        cacheKey: cacheEntry.cacheKey,
      },
    });
    expect(ledger.entries[0]?.cooldownUntil).toBe(cooldownUntil);
  });

  it("任意の二日間について責務・edge・severity差分を再生する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const snapshots = [
      {
        date: "2026-07-31",
        snapshot: createSnapshot({
          runId: "run-history-1",
          generatedAt: "2026-07-31T00:00:00.000Z",
          repositoryIds: [publicRepositoryId],
          responsibility: {
            status: "new_untriaged",
            kind: "role",
            candidateId: "role:maintainer",
            role: "maintainer",
          },
          severity: "watch",
          edge: {
            status: "absent",
          },
        }),
      },
      {
        date: "2026-08-01",
        snapshot: createSnapshot({
          runId: "run-history-2",
          generatedAt: "2026-08-01T00:00:00.000Z",
          repositoryIds: [publicRepositoryId],
          responsibility: {
            status: "waiting_for_review",
            kind: "team",
            candidateId: "team:reviewers",
            role: "reviewer",
          },
          severity: "urgent",
          edge: {
            status: "active",
          },
        }),
      },
      {
        date: "2026-08-02",
        snapshot: createSnapshot({
          runId: "run-history-3",
          generatedAt: "2026-08-02T00:00:00.000Z",
          repositoryIds: [publicRepositoryId],
          responsibility: {
            status: "waiting_for_author",
            kind: "role",
            candidateId: "role:author",
            role: "author",
          },
          severity: "critical",
          edge: {
            status: "inactive",
          },
        }),
      },
    ] as const;
    for (const fixture of snapshots) {
      const session = await StatePersistenceSession.open(adapter, stateConfiguration);
      await session.persist({
        snapshot: fixture.snapshot,
        notificationLedger: createEmptyStateNotificationLedger(),
        runReport: createRunReport(fixture.snapshot, fixture.date, []),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [],
      });
    }

    const replaySession = await StatePersistenceSession.open(adapter, stateConfiguration);
    const diff = await replaySession.diffHistory("2026-07-31", "2026-08-02");

    expect(diff.responsibilities).toHaveLength(1);
    expect(diff.responsibilities[0]).toMatchObject({
      id: itemNodeId,
      before: {
        status: "present",
        value: {
          waitingOn: [
            {
              candidateId: "role:maintainer",
            },
          ],
        },
      },
      after: {
        status: "present",
        value: {
          waitingOn: [
            {
              candidateId: "role:author",
            },
          ],
        },
      },
    });
    expect(diff.edges).toEqual([
      {
        id: "relation:blocker",
        before: {
          status: "absent",
        },
        after: {
          status: "present",
          value: {
            fromNodeId: "I_BLOCKER",
            toNodeId: itemNodeId,
            type: "blocks",
            active: false,
          },
        },
      },
    ]);
    expect(diff.severities).toEqual([
      {
        id: itemNodeId,
        before: {
          status: "present",
          value: "watch",
        },
        after: {
          status: "present",
          value: "critical",
        },
      },
    ]);
  });
});

describe("Git state branch adapter", () => {
  it("mainを変えず、初回orphan tracker-stateと後続commitを作成する", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "voicevox-state-git-test-"));
    try {
      await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", temporaryDirectory]);
      await execFileAsync("git", ["-C", temporaryDirectory, "config", "user.name", "fixture"]);
      await execFileAsync("git", [
        "-C",
        temporaryDirectory,
        "config",
        "user.email",
        "fixture@example.com",
      ]);
      await execFileAsync("git", ["-C", temporaryDirectory, "config", "commit.gpgsign", "false"]);
      await writeFile(join(temporaryDirectory, "README.md"), "main branch\n", "utf8");
      await execFileAsync("git", ["-C", temporaryDirectory, "add", "README.md"]);
      await execFileAsync("git", ["-C", temporaryDirectory, "commit", "--quiet", "-m", "initial"]);
      const mainBefore = await readGitOutput(temporaryDirectory, ["rev-parse", "refs/heads/main"]);
      const adapter = new GitStateBranchAdapter({
        repositoryPath: temporaryDirectory,
        gitExecutable: "git",
        authorName: "VOICEVOX Task Tracker",
        authorEmail: "voicevox-task-tracker@example.com",
      });
      const firstSnapshot = createSnapshot({
        runId: "run-git-bootstrap",
        generatedAt: "2026-07-31T00:00:00.000Z",
        repositoryIds: [publicRepositoryId],
        responsibility: {
          status: "new_untriaged",
          kind: "role",
          candidateId: "role:maintainer",
          role: "maintainer",
        },
        severity: "watch",
        edge: {
          status: "absent",
        },
      });
      const firstSession = await StatePersistenceSession.open(adapter, stateConfiguration);
      const first = await firstSession.persist({
        snapshot: firstSnapshot,
        notificationLedger: createEmptyStateNotificationLedger(),
        runReport: createRunReport(firstSnapshot, "2026-07-31", []),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [],
      });
      const firstParents = await readGitOutput(temporaryDirectory, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        first.revision,
      ]);

      const secondSnapshot = createSnapshot({
        runId: "run-git-next",
        generatedAt: "2026-08-01T00:00:00.000Z",
        repositoryIds: [publicRepositoryId],
        responsibility: {
          status: "waiting_for_review",
          kind: "team",
          candidateId: "team:reviewers",
          role: "reviewer",
        },
        severity: "urgent",
        edge: {
          status: "active",
        },
      });
      const secondSession = await StatePersistenceSession.open(adapter, stateConfiguration);
      const second = await secondSession.persist({
        snapshot: secondSnapshot,
        notificationLedger: createEmptyStateNotificationLedger(),
        runReport: createRunReport(secondSnapshot, "2026-08-01", []),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [],
      });
      const mainAfter = await readGitOutput(temporaryDirectory, ["rev-parse", "refs/heads/main"]);
      const mainSnapshotExists = await execFileAsync(
        "git",
        ["-C", temporaryDirectory, "cat-file", "-e", "main:state/snapshot.json"],
        {
          encoding: "utf8",
        },
      ).then(
        () => true,
        () => false,
      );
      const trackerSnapshot = await readGitOutput(temporaryDirectory, [
        "show",
        "tracker-state:state/snapshot.json",
      ]);

      expect(first.branchCreated).toBe(true);
      expect(firstParents.split(" ")).toEqual([first.revision]);
      expect(second.branchCreated).toBe(false);
      expect(mainAfter).toBe(mainBefore);
      expect(mainSnapshotExists).toBe(false);
      expect(JSON.parse(trackerSnapshot)).toMatchObject({
        run: {
          id: "run-git-next",
        },
      });
    } finally {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});
