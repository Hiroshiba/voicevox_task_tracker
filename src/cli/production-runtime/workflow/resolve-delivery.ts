import { resolve } from "node:path";

import { resolveManualNotificationDelivery } from "../../manual-resolution.js";
import type { WorkflowStageDependencies } from "../../workflow-stage.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type DeliveryResolutionRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "repositoryPath" | "loadConfig" | "createStateBranchAdapter" | "now" | "writeJsonArtifact"
>;

/** workflowの手動解決を同じrunのCASへ接続する。 */
export function createResolveDiscordDeliveryStage(
  adapters: DeliveryResolutionRuntimeAdapters,
): WorkflowStageDependencies["resolveDiscordDelivery"] {
  return async (command) => {
    const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
    const result = await resolveManualNotificationDelivery(
      {
        adapter: adapters.createStateBranchAdapter(),
        configuration: config.state,
        knownSecrets: [],
        now: adapters.now,
      },
      {
        runId: command.runId,
        checkpointDigest: command.checkpointDigest,
        deliveryId: command.deliveryId,
        attemptId: command.attemptId,
        notificationKeys: command.notificationKeys,
        decision: command.resolution,
      },
    );
    await adapters.writeJsonArtifact(
      resolve(adapters.repositoryPath, command.receiptPath),
      result.receipt,
    );
  };
}
