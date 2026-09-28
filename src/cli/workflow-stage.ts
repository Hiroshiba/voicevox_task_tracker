import {
  type BuildPagesCliCommand,
  type PreflightPagesDeploymentCliCommand,
  type RecordPagesDeploymentCliCommand,
  type NotifyDiscordCliCommand,
  type NotifyOperationsCliCommand,
  type PersistStateCliCommand,
  type ReportWorkflowCliCommand,
  type ResolveDiscordDeliveryCliCommand,
  type VerifyCheckpointCliCommand,
  type VerifyRuntimeRecoveryCliCommand,
  type VerifyReceiptChainCliCommand,
  type ReportFailureCliCommand,
  type InspectRunStateCliCommand,
} from "./command.js";

/** 日次workflowの後続stageで受け付けるCLI入力。 */
export type WorkflowStageCliCommand =
  | PersistStateCliCommand
  | BuildPagesCliCommand
  | PreflightPagesDeploymentCliCommand
  | RecordPagesDeploymentCliCommand
  | NotifyDiscordCliCommand
  | ResolveDiscordDeliveryCliCommand
  | NotifyOperationsCliCommand
  | ReportWorkflowCliCommand
  | VerifyCheckpointCliCommand
  | VerifyRuntimeRecoveryCliCommand
  | InspectRunStateCliCommand
  | VerifyReceiptChainCliCommand
  | ReportFailureCliCommand;

/** workflow stageの外部副作用を注入する境界。 */
export type WorkflowStageDependencies = Readonly<{
  persistState: (command: PersistStateCliCommand) => Promise<void>;
  buildPages: (command: BuildPagesCliCommand) => Promise<void>;
  preflightPagesDeployment: (command: PreflightPagesDeploymentCliCommand) => Promise<void>;
  recordPagesDeployment: (command: RecordPagesDeploymentCliCommand) => Promise<void>;
  notifyDiscord: (command: NotifyDiscordCliCommand) => Promise<void>;
  resolveDiscordDelivery: (command: ResolveDiscordDeliveryCliCommand) => Promise<void>;
  notifyOperations: (command: NotifyOperationsCliCommand) => Promise<void>;
  reportWorkflow: (command: ReportWorkflowCliCommand) => Promise<void>;
  verifyCheckpoint: (command: VerifyCheckpointCliCommand) => Promise<void>;
  verifyRuntimeRecovery: (command: VerifyRuntimeRecoveryCliCommand) => Promise<void>;
  inspectRunState: (command: InspectRunStateCliCommand) => Promise<void>;
  verifyReceiptChain: (command: VerifyReceiptChainCliCommand) => Promise<void>;
  reportFailure: (command: ReportFailureCliCommand) => Promise<void>;
}>;

/** 日次workflowの後続stageを振り分ける。 */
export class WorkflowStageRunner {
  readonly #dependencies: WorkflowStageDependencies;

  public constructor(dependencies: WorkflowStageDependencies) {
    this.#dependencies = dependencies;
  }

  /** 指定された一つのworkflow stageを実行する。 */
  public async run(command: WorkflowStageCliCommand): Promise<void> {
    switch (command.kind) {
      case "persist-state":
        await this.#dependencies.persistState(command);
        return;
      case "build-pages":
        await this.#dependencies.buildPages(command);
        return;
      case "preflight-pages-deployment":
        await this.#dependencies.preflightPagesDeployment(command);
        return;
      case "record-pages-deployment":
        await this.#dependencies.recordPagesDeployment(command);
        return;
      case "notify-discord":
        await this.#dependencies.notifyDiscord(command);
        return;
      case "resolve-discord-delivery":
        await this.#dependencies.resolveDiscordDelivery(command);
        return;
      case "notify-operations":
        await this.#dependencies.notifyOperations(command);
        return;
      case "report-workflow":
        await this.#dependencies.reportWorkflow(command);
        return;
      case "verify-checkpoint":
        await this.#dependencies.verifyCheckpoint(command);
        return;
      case "verify-runtime-recovery":
        await this.#dependencies.verifyRuntimeRecovery(command);
        return;
      case "inspect-run-state":
        await this.#dependencies.inspectRunState(command);
        return;
      case "verify-receipt-chain":
        await this.#dependencies.verifyReceiptChain(command);
        return;
      case "report-failure":
        await this.#dependencies.reportFailure(command);
        return;
    }
  }
}
