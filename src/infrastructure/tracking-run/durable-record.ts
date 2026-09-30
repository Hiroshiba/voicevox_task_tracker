import type { ContentDigestPort } from "../../application/tracking-run/ports.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  durablePublicationRecordTemplateSchema,
  parseDurablePublicationRecord,
  type DurablePublicationRecord,
} from "../../publication/durable-record-schema.js";
import {
  assertBoundPublicationCheckpoint,
  type BoundPublicationCheckpoint,
} from "./publication-checkpoint-binding.js";
/** 検証済みcheckpointの業務値とbindingから永続recordを作る。 */
export function materializeDurablePublicationRecord(
  bound: BoundPublicationCheckpoint,
  digest: ContentDigestPort,
): DurablePublicationRecord {
  assertBoundPublicationCheckpoint(bound);
  const template = durablePublicationRecordTemplateSchema.parse(
    bound.publicationPlan.durableRecordTemplate,
  );
  if (
    serializeCanonicalJson(template) !==
      serializeCanonicalJson(bound.publicationPlan.initialStateWriteSet.durableRecordTemplate) ||
    serializeCanonicalJson(template.runIdentity) !==
      serializeCanonicalJson(bound.checkpoint.runIdentity) ||
    serializeCanonicalJson(template.executionPolicy) !==
      serializeCanonicalJson(bound.checkpoint.executionPolicy) ||
    serializeCanonicalJson(template.baseStateRevision) !==
      serializeCanonicalJson(bound.checkpoint.baseStateRevision) ||
    template.configDigest !== bound.checkpoint.configDigest ||
    bound.bindingProof.checkpointDigest !== bound.checkpointDigest ||
    bound.bindingProof.checkpointFileDigest !== bound.binding.checkpointFileDigest ||
    bound.bindingProof.runtimeIdentityDigest !==
      digest.sha256Utf8(serializeCanonicalJson(bound.runtimeIdentity)) ||
    bound.bindingProof.runtimeRecoveryPlanDigest !==
      digest.sha256Utf8(serializeCanonicalJson(bound.binding.runtimeRecoveryPlan))
  ) {
    throw new TypeError("checkpointと永続record templateの結合が一致しません");
  }
  const schemaVersion = template.executionPolicy.executionShape === "split_workflow" ? 2 : 1;
  if (bound.binding.runtimeRecoveryPlan.schemaVersion !== schemaVersion) {
    throw new TypeError("永続recordの版と回復計画の版が一致しません");
  }
  const payload = {
    recoveryBootstrapVersion: 1,
    schemaVersion,
    runIdentity: template.runIdentity,
    executionPolicy: template.executionPolicy,
    checkpointDigest: bound.checkpointDigest,
    checkpointFileDigest: bound.binding.checkpointFileDigest,
    runtimeIdentity: bound.runtimeIdentity,
    runtimeRecoveryPlan: bound.binding.runtimeRecoveryPlan,
    configDigest: template.configDigest,
    baseStateRevision: template.baseStateRevision,
    initialStateContentDigests: template.initialStateValueDigests,
    initialPagesProjection: template.initialPagesProjection,
    notificationOutbox: template.notificationOutbox,
    runFinalizationPolicy: template.runFinalizationPolicy,
    notificationHistoryPagesPolicy: template.notificationHistoryPagesPolicy,
  };
  return parseDurablePublicationRecord(
    { ...payload, recordDigest: digest.sha256Utf8(serializeCanonicalJson(payload)) },
    digest,
  );
}
