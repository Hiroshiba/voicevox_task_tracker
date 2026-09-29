/** 共通engineが新規runで進める業務段階。 */
export const trackingRunStageOrder = [
  "bootstrap",
  "prepare",
  "checkpoint",
  "initial_state_commit",
  "initial_pages",
  "notifications_settled",
  "finalization",
  "notification_history_pages",
  "complete",
] as const;

/** 初回commit後にメモリ上のcheckpointを破棄して渡す識別子。 */
export type InitialStateCommitReference = Readonly<{
  stateRevision: string;
  stateContentDigest: string;
}>;

/** 同じ段階を直列実行と分割workflowから呼ぶための境界。 */
export type TrackingRunEnginePorts<
  Bootstrap,
  Prepared,
  Checkpoint,
  Durable extends Readonly<{ stateContentDigest: string }>,
  InitialPages,
  Settled,
  Finalized,
  HistoryPages,
  Completed,
> = Readonly<{
  bootstrap: () => Promise<Bootstrap>;
  prepare: (bootstrap: Bootstrap) => Promise<Prepared>;
  checkpoint: (prepared: Prepared) => Promise<Checkpoint>;
  commitInitialState: (checkpoint: Checkpoint) => Promise<InitialStateCommitReference>;
  readCommittedState: (reference: InitialStateCommitReference) => Promise<Durable>;
  publishInitialPages: (durable: Durable) => Promise<InitialPages>;
  settleNotifications: (initialPages: InitialPages) => Promise<Settled>;
  finalizeRun: (settled: Settled) => Promise<Finalized>;
  publishNotificationHistoryPages: (finalized: Finalized) => Promise<HistoryPages>;
  complete: (historyPages: HistoryPages) => Promise<Completed>;
}>;

/** prepare済みrunをcheckpointから完了まで進める共通port。 */
export type PreparedTrackingRunPorts<
  Prepared,
  Checkpoint,
  Durable extends Readonly<{ stateContentDigest: string }>,
  InitialPages,
  Settled,
  Finalized,
  HistoryPages,
  Completed,
> = Pick<
  TrackingRunEnginePorts<
    never,
    Prepared,
    Checkpoint,
    Durable,
    InitialPages,
    Settled,
    Finalized,
    HistoryPages,
    Completed
  >,
  | "checkpoint"
  | "commitInitialState"
  | "readCommittedState"
  | "publishInitialPages"
  | "settleNotifications"
  | "finalizeRun"
  | "publishNotificationHistoryPages"
  | "complete"
>;

/** prepare済みrunのcheckpoint以後を同じengineで実行する。 */
export async function runPreparedTrackingRun<
  Prepared,
  Checkpoint,
  Durable extends Readonly<{ stateContentDigest: string }>,
  InitialPages,
  Settled,
  Finalized,
  HistoryPages,
  Completed,
>(
  prepared: Prepared,
  ports: PreparedTrackingRunPorts<
    Prepared,
    Checkpoint,
    Durable,
    InitialPages,
    Settled,
    Finalized,
    HistoryPages,
    Completed
  >,
): Promise<Completed> {
  let reference: InitialStateCommitReference;
  {
    const checkpoint = await ports.checkpoint(prepared);
    reference = await ports.commitInitialState(checkpoint);
  }
  const durable = await ports.readCommittedState(reference);
  if (durable.stateContentDigest !== reference.stateContentDigest) {
    throw new TypeError("初回commit後に再読込したstateが一致しません");
  }
  const initialPages = await ports.publishInitialPages(durable);
  const settled = await ports.settleNotifications(initialPages);
  const finalized = await ports.finalizeRun(settled);
  const historyPages = await ports.publishNotificationHistoryPages(finalized);
  return ports.complete(historyPages);
}

/** checkpointを初回commit以後に渡さず、永続stateから後半を進める。 */
export async function runTrackingRunSequentially<
  Bootstrap,
  Prepared,
  Checkpoint,
  Durable extends Readonly<{ stateContentDigest: string }>,
  InitialPages,
  Settled,
  Finalized,
  HistoryPages,
  Completed,
>(
  ports: TrackingRunEnginePorts<
    Bootstrap,
    Prepared,
    Checkpoint,
    Durable,
    InitialPages,
    Settled,
    Finalized,
    HistoryPages,
    Completed
  >,
): Promise<Completed> {
  const bootstrap = await ports.bootstrap();
  const prepared = await ports.prepare(bootstrap);
  return runPreparedTrackingRun(prepared, ports);
}
