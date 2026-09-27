import type { RunIdentity, RunRequest } from "../../../application/tracking-run/request.js";
import type { PreparedRun } from "../../../application/tracking-run/prepare-run.js";
import { UnreachableError } from "../../../util/index.js";
import type {
  BackfillCliCommand,
  CliSchedule,
  CollectAnalyzeCliCommand,
  DailyCliCommand,
  DryRunCliCommand,
} from "../../command.js";
import type { DailyRunInvocation } from "../../daily-transaction.js";

function legacyCommand(
  request: RunRequest,
): DailyCliCommand | DryRunCliCommand | BackfillCliCommand | CollectAnalyzeCliCommand {
  const common = {
    configPath: request.configPath,
    reportPath: request.reportPath,
    schedule: {
      kind: "specified",
      value: request.scheduledFor,
    } satisfies CliSchedule,
  };
  switch (request.requestKind) {
    case "sequential_daily":
      return Object.freeze({
        ...common,
        kind: "daily",
        notificationAction: request.executionPolicy.notificationAction,
        sandboxContextPath: undefined,
      });
    case "split_daily":
      return Object.freeze({
        ...common,
        kind: "collect-analyze",
        mode: "none",
        repositoryFilter: Object.freeze([]),
        notificationAction: request.executionPolicy.notificationAction,
        artifactPath: request.output.path,
      });
    case "backfill_none":
      return Object.freeze({
        ...common,
        kind: "backfill",
        mode: "none",
        repositoryFilter: Object.freeze([]),
        notificationAction: request.executionPolicy.notificationAction,
      });
    case "sandbox_daily":
      return Object.freeze({
        ...common,
        kind: "daily",
        notificationAction: request.executionPolicy.notificationAction,
        sandboxContextPath: request.sandboxContextPath,
      });
    case "dry_run":
      return Object.freeze({
        ...common,
        kind: "dry-run",
        artifactPath: request.output.path,
      });
    case "split_backfill":
      return Object.freeze({
        ...common,
        kind: "collect-analyze",
        mode: request.executionPolicy.backfillRange.kind,
        repositoryFilter: request.executionPolicy.backfillRange.repositories,
        notificationAction: request.executionPolicy.notificationAction,
        artifactPath: request.output.path,
      });
    case "sequential_backfill":
      return Object.freeze({
        ...common,
        kind: "backfill",
        mode: request.executionPolicy.backfillRange.kind,
        repositoryFilter: request.executionPolicy.backfillRange.repositories,
        notificationAction: request.executionPolicy.notificationAction,
      });
    default:
      throw new UnreachableError(request);
  }
}

/** 未移行の下流段階へ検証済み要求の値だけを投影する。 */
export function projectLegacyDailyInvocation(
  request: RunRequest,
  identity: RunIdentity,
): DailyRunInvocation {
  return Object.freeze({
    runId: identity.runId,
    invocationId: identity.invocationId,
    executionPolicy: request.executionPolicy,
    command: legacyCommand(request),
    scheduledFor: identity.scheduledFor,
    startedAt: identity.startedAt,
  });
}

/** 準備済みrunから未移行の下流段階へ値だけを投影する。 */
export function projectPreparedLegacyDailyInvocation(prepared: PreparedRun): DailyRunInvocation {
  return projectLegacyDailyInvocation(prepared.data.request, prepared.core.identity);
}
