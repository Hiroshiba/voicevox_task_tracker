import { z } from "zod";

import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import type { ContentDigestPort } from "./ports.js";
import {
  pagesDeploymentExternalReferenceSchema,
  pagesPublicUrlSchema,
  type PagesBuildReceipt,
  type PagesDeploymentReceipt,
} from "./receipt-schema.js";
import { parseReceipt } from "./receipt-codec.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const MAX_EVIDENCE_BYTES = 1024 * 1024;
export const INITIAL_PAGES_PUBLICATION_EVIDENCE_SCHEMA_VERSION = 1;

export const initialPagesPublicationEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(INITIAL_PAGES_PUBLICATION_EVIDENCE_SCHEMA_VERSION),
  runId: runIdSchema,
  checkpointDigest: sha256Schema,
  sourceStateRevision: revisionSchema,
  deploymentOperationId: z.string().regex(/^operation:v1:[0-9a-f]{64}$/u),
  deploymentReceiptDigest: sha256Schema,
  deploymentIntentDigest: sha256Schema,
  pagesContentDigest: sha256Schema,
  pageUrl: pagesPublicUrlSchema,
  effectCertainty: z.literal("committed"),
  externalReference: pagesDeploymentExternalReferenceSchema,
  observedAt: z.iso.datetime({ offset: true }),
  effectOccurredAt: z.iso.datetime({ offset: true }).optional(),
  evidenceDigest: sha256Schema,
});

/** 初回Pagesの成功をstateへ保存する公開証拠。 */
export type InitialPagesPublicationEvidence = z.output<
  typeof initialPagesPublicationEvidenceSchema
>;

/** 同じexact revisionで読んだmarkerとevidenceの対応。 */
export type InitialPagesEvidenceState = Readonly<{
  exactStateRevision: string;
  marker: Readonly<{
    runId: string;
    checkpointDigest: string;
    phase: "notifications_in_progress" | "notifications_settled" | "run_finalized";
    initialPagesPublicationEvidenceDigest: string;
    initialStateRevision: string;
  }>;
  evidence: InitialPagesPublicationEvidence;
}>;

/** build、deploy、intentの一致から初回Pages保存証拠を作る。 */
export function createInitialPagesPublicationEvidence(
  input: Readonly<{
    buildReceipt: PagesBuildReceipt;
    deploymentReceipt: PagesDeploymentReceipt;
    sourceStateRevision: string;
  }>,
  digest: ContentDigestPort,
): InitialPagesPublicationEvidence {
  const build = parseReceipt(input.buildReceipt, digest);
  const deployment = parseReceipt(input.deploymentReceipt, digest);
  if (
    build.receiptType !== "pages_build" ||
    build.phase !== "initial" ||
    build.status !== "built" ||
    build.receiptKind !== "executed" ||
    build.result == null ||
    deployment.receiptType !== "pages_deployment" ||
    deployment.phase !== "initial" ||
    (deployment.status !== "deployed" && deployment.status !== "replayed_same_content") ||
    deployment.receiptKind !== "executed" ||
    deployment.result == null ||
    deployment.binding.bindingKind !== "checkpoint" ||
    build.binding.bindingKind !== "checkpoint" ||
    serializeCanonicalJson(build.binding) !== serializeCanonicalJson(deployment.binding) ||
    deployment.previousReceiptDigest !== build.receiptDigest ||
    deployment.phaseSequence !== build.phaseSequence + 1 ||
    build.result.sourceStateRevision !== input.sourceStateRevision ||
    deployment.result.sourceStateRevision !== input.sourceStateRevision ||
    build.result.pagesContentDigest !== deployment.result.pagesContentDigest ||
    build.result.deploymentIntentDigest !== deployment.result.deploymentIntentDigest ||
    deployment.logicalTarget !== deployment.result.deploymentIntentDigest
  ) {
    throw new TypeError("初回Pagesのbuild、intent、deployment receiptが一致しません");
  }
  const payload = {
    schemaVersion: INITIAL_PAGES_PUBLICATION_EVIDENCE_SCHEMA_VERSION,
    runId: deployment.binding.runId,
    checkpointDigest: deployment.binding.checkpointDigest,
    sourceStateRevision: input.sourceStateRevision,
    deploymentOperationId: deployment.operationId,
    deploymentReceiptDigest: deployment.receiptDigest,
    deploymentIntentDigest: deployment.result.deploymentIntentDigest,
    pagesContentDigest: deployment.result.pagesContentDigest,
    pageUrl: deployment.result.pageUrl,
    effectCertainty: "committed",
    externalReference: deployment.result.externalReference,
    observedAt: deployment.observedAt,
    ...(deployment.effectOccurredAt == null
      ? {}
      : { effectOccurredAt: deployment.effectOccurredAt }),
  };
  return parseInitialPagesPublicationEvidence(
    { ...payload, evidenceDigest: digest.sha256Utf8(serializeCanonicalJson(payload)) },
    digest,
  );
}

/** 保存証拠のshapeとcanonical digestを検証する。 */
export function parseInitialPagesPublicationEvidence(
  value: unknown,
  digest: ContentDigestPort,
): InitialPagesPublicationEvidence {
  const evidence = initialPagesPublicationEvidenceSchema.parse(value);
  const { evidenceDigest, ...payload } = evidence;
  if (digest.sha256Utf8(serializeCanonicalJson(payload)) !== evidenceDigest) {
    throw new TypeError("初回Pages保存証拠のdigestが一致しません");
  }
  return evidence;
}

/** canonical JSONで保存した初回Pages証拠を読む。 */
export function decodeInitialPagesPublicationEvidence(
  bytes: Uint8Array,
  digest: ContentDigestPort,
): InitialPagesPublicationEvidence {
  if (bytes.length > MAX_EVIDENCE_BYTES) {
    throw new TypeError("初回Pages証拠が許容するbyte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("初回Pages証拠がcanonical JSONではありません");
  }
  return parseInitialPagesPublicationEvidence(raw, digest);
}

/** 初回Pages証拠をcanonical JSONで保存する。 */
export function serializeInitialPagesPublicationEvidence(
  evidence: InitialPagesPublicationEvidence,
  digest: ContentDigestPort,
): string {
  return serializeCanonicalJsonLine(parseInitialPagesPublicationEvidence(evidence, digest));
}
