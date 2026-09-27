import type {
  GenericAiElementAdoption,
  GenericAiItemAdoption,
} from "../../../application/tracking-run/stages/generic-ai-adoption-contracts.js";
import type { z } from "zod";
import {
  CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
  type CodexPreservedElements,
} from "../../../codex/index.js";
import {
  createAiAnalysisElementResultSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElementReuseProof,
} from "../../../domain/ai-analysis-elements.js";
import { createAiAnalysisElementSourceGenerationSchema } from "../../../domain/ai-analysis-source-generations.js";
import type {
  NaturalLanguageDeadlineAssessmentState,
  NaturalLanguageImportanceAssessmentState,
  TrackedItemAiAnalysis,
} from "../../../domain/index.js";
import type { DeterministicItemAnalysis } from "../../../application/tracking-run/stages/deterministic-item.js";
import type { ConsumerCodexElementOutput } from "../../production-runtime/reduction/consumer-output.js";

const codecs = Object.freeze({
  status: Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema("status"),
    generation: createAiAnalysisElementSourceGenerationSchema("status"),
  }),
  waitingOn: Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema("waitingOn"),
    generation: createAiAnalysisElementSourceGenerationSchema("waitingOn"),
  }),
  nextAction: Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema("nextAction"),
    generation: createAiAnalysisElementSourceGenerationSchema("nextAction"),
  }),
  relations: Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema("relations"),
    generation: createAiAnalysisElementSourceGenerationSchema("relations"),
  }),
  progress: Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema("progress"),
    generation: createAiAnalysisElementSourceGenerationSchema("progress"),
  }),
  importance: Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema("importance"),
    generation: createAiAnalysisElementSourceGenerationSchema("importance"),
  }),
  deadline: Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema("deadline"),
    generation: createAiAnalysisElementSourceGenerationSchema("deadline"),
  }),
  notification: Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema("notification"),
    generation: createAiAnalysisElementSourceGenerationSchema("notification"),
  }),
  selfCommitment: Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema("selfCommitment"),
    generation: createAiAnalysisElementSourceGenerationSchema("selfCommitment"),
  }),
});

function adoptedResult<Result>(
  record: GenericAiElementAdoption,
  schema: z.ZodType<Result>,
): Result | undefined {
  return record.adopted.status === "ai" ? schema.parse(record.adopted.result) : undefined;
}

function evaluatedElement<Result, Generation>(
  record: GenericAiElementAdoption,
  resultSchema: z.ZodType<Result>,
  generationSchema: z.ZodType<Generation>,
):
  | Readonly<{
      generation: Generation;
      result: Result;
      evaluationProof: AiAnalysisElementReuseProof;
    }>
  | undefined {
  const evaluated = record.evaluated;
  if (evaluated == null) {
    return undefined;
  }
  return Object.freeze({
    generation: generationSchema.parse(evaluated.generation),
    result: resultSchema.parse(evaluated.result),
    evaluationProof: evaluated.proof,
  });
}

function storedElement<Result, Generation>(
  record: GenericAiElementAdoption,
  resultSchema: z.ZodType<Result>,
  generationSchema: z.ZodType<Generation>,
):
  | Readonly<{ origin: "migration"; result: Result; reuseProof: AiAnalysisElementReuseProof }>
  | Readonly<{
      origin: "current";
      generation: Generation;
      result: Result;
      reuseProof: AiAnalysisElementReuseProof;
    }>
  | undefined {
  const adopted = record.adopted;
  const value = adopted.status === "ai" ? adopted : record.retained;
  if (value == null) {
    return undefined;
  }
  const result = resultSchema.parse(value.result);
  if (value.origin === "migration") {
    return Object.freeze({
      origin: "migration",
      result,
      reuseProof: value.proof,
    });
  }
  if (value.generation == null) {
    throw new TypeError(`汎用AI採用値の生成元がありません。対象: ${record.element}`);
  }
  return Object.freeze({
    origin: "current",
    generation: generationSchema.parse(value.generation),
    result,
    reuseProof: value.proof,
  });
}

/** 採用記録から未移行のsnapshot形式へ値を投影する。 */
export function projectLegacyTrackedItemAiAnalysis(
  item: GenericAiItemAdoption,
): TrackedItemAiAnalysis {
  const records = item.elements;
  const statusEvaluated = evaluatedElement(
    records.status,
    codecs.status.result,
    codecs.status.generation,
  );
  const waitingOnEvaluated = evaluatedElement(
    records.waitingOn,
    codecs.waitingOn.result,
    codecs.waitingOn.generation,
  );
  const nextActionEvaluated = evaluatedElement(
    records.nextAction,
    codecs.nextAction.result,
    codecs.nextAction.generation,
  );
  const relationsEvaluated = evaluatedElement(
    records.relations,
    codecs.relations.result,
    codecs.relations.generation,
  );
  const progressEvaluated = evaluatedElement(
    records.progress,
    codecs.progress.result,
    codecs.progress.generation,
  );
  const importanceEvaluated = evaluatedElement(
    records.importance,
    codecs.importance.result,
    codecs.importance.generation,
  );
  const deadlineEvaluated = evaluatedElement(
    records.deadline,
    codecs.deadline.result,
    codecs.deadline.generation,
  );
  const notificationEvaluated = evaluatedElement(
    records.notification,
    codecs.notification.result,
    codecs.notification.generation,
  );
  const selfCommitmentEvaluated = evaluatedElement(
    records.selfCommitment,
    codecs.selfCommitment.result,
    codecs.selfCommitment.generation,
  );
  const elements = Object.freeze({
    ...(statusEvaluated == null ? {} : { status: statusEvaluated }),
    ...(waitingOnEvaluated == null ? {} : { waitingOn: waitingOnEvaluated }),
    ...(nextActionEvaluated == null ? {} : { nextAction: nextActionEvaluated }),
    ...(relationsEvaluated == null ? {} : { relations: relationsEvaluated }),
    ...(progressEvaluated == null ? {} : { progress: progressEvaluated }),
    ...(importanceEvaluated == null ? {} : { importance: importanceEvaluated }),
    ...(deadlineEvaluated == null ? {} : { deadline: deadlineEvaluated }),
    ...(notificationEvaluated == null ? {} : { notification: notificationEvaluated }),
    ...(selfCommitmentEvaluated == null ? {} : { selfCommitment: selfCommitmentEvaluated }),
  });
  const statusAdopted = storedElement(
    records.status,
    codecs.status.result,
    codecs.status.generation,
  );
  const waitingOnAdopted = storedElement(
    records.waitingOn,
    codecs.waitingOn.result,
    codecs.waitingOn.generation,
  );
  const nextActionAdopted = storedElement(
    records.nextAction,
    codecs.nextAction.result,
    codecs.nextAction.generation,
  );
  const relationsAdopted = storedElement(
    records.relations,
    codecs.relations.result,
    codecs.relations.generation,
  );
  const progressAdopted = storedElement(
    records.progress,
    codecs.progress.result,
    codecs.progress.generation,
  );
  const importanceAdopted = storedElement(
    records.importance,
    codecs.importance.result,
    codecs.importance.generation,
  );
  const deadlineAdopted = storedElement(
    records.deadline,
    codecs.deadline.result,
    codecs.deadline.generation,
  );
  const notificationAdopted = storedElement(
    records.notification,
    codecs.notification.result,
    codecs.notification.generation,
  );
  const selfCommitmentAdopted = storedElement(
    records.selfCommitment,
    codecs.selfCommitment.result,
    codecs.selfCommitment.generation,
  );
  const adoptedElements = Object.freeze({
    ...(statusAdopted == null ? {} : { status: statusAdopted }),
    ...(waitingOnAdopted == null ? {} : { waitingOn: waitingOnAdopted }),
    ...(nextActionAdopted == null ? {} : { nextAction: nextActionAdopted }),
    ...(relationsAdopted == null ? {} : { relations: relationsAdopted }),
    ...(progressAdopted == null ? {} : { progress: progressAdopted }),
    ...(importanceAdopted == null ? {} : { importance: importanceAdopted }),
    ...(deadlineAdopted == null ? {} : { deadline: deadlineAdopted }),
    ...(notificationAdopted == null ? {} : { notification: notificationAdopted }),
    ...(selfCommitmentAdopted == null ? {} : { selfCommitment: selfCommitmentAdopted }),
  });
  const applications = Object.freeze({
    status: records.status.application,
    waitingOn: records.waitingOn.application,
    nextAction: records.nextAction.application,
    relations: records.relations.application,
    progress: records.progress.application,
    importance: records.importance.application,
    deadline: records.deadline.application,
    notification: records.notification.application,
    selfCommitment: records.selfCommitment.application,
  });
  if (Object.values(adoptedElements).some((value) => value.origin === "migration")) {
    return Object.freeze({
      origin: "migration",
      status: item.status,
      elements,
      adoptedElements,
      applications,
    });
  }
  const currentAdoptedElements = Object.freeze({
    ...(adoptedElements.status?.origin === "current" ? { status: adoptedElements.status } : {}),
    ...(adoptedElements.waitingOn?.origin === "current"
      ? { waitingOn: adoptedElements.waitingOn }
      : {}),
    ...(adoptedElements.nextAction?.origin === "current"
      ? { nextAction: adoptedElements.nextAction }
      : {}),
    ...(adoptedElements.relations?.origin === "current"
      ? { relations: adoptedElements.relations }
      : {}),
    ...(adoptedElements.progress?.origin === "current"
      ? { progress: adoptedElements.progress }
      : {}),
    ...(adoptedElements.importance?.origin === "current"
      ? { importance: adoptedElements.importance }
      : {}),
    ...(adoptedElements.deadline?.origin === "current"
      ? { deadline: adoptedElements.deadline }
      : {}),
    ...(adoptedElements.notification?.origin === "current"
      ? { notification: adoptedElements.notification }
      : {}),
    ...(adoptedElements.selfCommitment?.origin === "current"
      ? { selfCommitment: adoptedElements.selfCommitment }
      : {}),
  });
  return Object.freeze({
    origin: "current",
    status: item.status,
    elements,
    adoptedElements: currentAdoptedElements,
    applications,
  });
}

/** 採用されたAI値だけを未移行の再判定入力へ投影する。 */
export function projectLegacyConsumerOutput(
  analysis: DeterministicItemAnalysis,
  item: GenericAiItemAdoption,
): ConsumerCodexElementOutput | undefined {
  const records = item.elements;
  const values = Object.freeze({
    status: adoptedResult(records.status, codecs.status.result),
    waitingOn: adoptedResult(records.waitingOn, codecs.waitingOn.result),
    nextAction: adoptedResult(records.nextAction, codecs.nextAction.result),
    relations: adoptedResult(records.relations, codecs.relations.result),
    progress: adoptedResult(records.progress, codecs.progress.result),
    importance: adoptedResult(records.importance, codecs.importance.result),
    deadline: adoptedResult(records.deadline, codecs.deadline.result),
    notification: adoptedResult(records.notification, codecs.notification.result),
    selfCommitment: adoptedResult(records.selfCommitment, codecs.selfCommitment.result),
  });
  if (Object.values(values).every((value) => value == null)) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
    item: Object.freeze({ nodeId: analysis.item.nodeId, url: analysis.item.url }),
    ...values,
  });
}

/** 採用されたAI値を未移行の純粋reducerへ投影する。 */
export function projectLegacyPreservedElements(
  item: GenericAiItemAdoption,
): CodexPreservedElements {
  const records = item.elements;
  const values = Object.freeze({
    status: adoptedResult(records.status, codecs.status.result),
    waitingOn: adoptedResult(records.waitingOn, codecs.waitingOn.result),
    nextAction: adoptedResult(records.nextAction, codecs.nextAction.result),
    relations: adoptedResult(records.relations, codecs.relations.result),
    progress: adoptedResult(records.progress, codecs.progress.result),
    importance: adoptedResult(records.importance, codecs.importance.result),
    deadline: adoptedResult(records.deadline, codecs.deadline.result),
    notification: adoptedResult(records.notification, codecs.notification.result),
    selfCommitment: adoptedResult(records.selfCommitment, codecs.selfCommitment.result),
  });
  return Object.freeze({
    ...(values.status == null ? {} : { status: values.status }),
    ...(values.waitingOn == null ? {} : { waitingOn: values.waitingOn }),
    ...(values.nextAction == null ? {} : { nextAction: values.nextAction }),
    ...(values.relations == null ? {} : { relations: values.relations }),
    ...(values.progress == null ? {} : { progress: values.progress }),
    ...(values.importance == null ? {} : { importance: values.importance }),
    ...(values.deadline == null ? {} : { deadline: values.deadline }),
    ...(values.notification == null ? {} : { notification: values.notification }),
    ...(values.selfCommitment == null ? {} : { selfCommitment: values.selfCommitment }),
  });
}

/** 採用済み重要度を未移行の評価状態へ投影する。 */
export function projectLegacyImportanceAssessment(
  item: GenericAiItemAdoption,
): NaturalLanguageImportanceAssessmentState | undefined {
  const result = adoptedResult(item.elements.importance, codecs.importance.result);
  if (result == null) {
    return undefined;
  }
  const parsed = createAiAnalysisElementResultSchema("importance").parse(result);
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      significantFeature: parsed.value.significantFeature,
      futureRisk: parsed.value.futureRisk,
      rationale: parsed.value.rationale,
    }),
  });
}

/** 採用済み期限を未移行の評価状態へ投影する。 */
export function projectLegacyDeadlineAssessment(
  item: GenericAiItemAdoption,
): NaturalLanguageDeadlineAssessmentState | undefined {
  const result = adoptedResult(item.elements.deadline, codecs.deadline.result);
  if (result == null) {
    return undefined;
  }
  const parsed = createAiAnalysisElementResultSchema("deadline").parse(result);
  return Object.freeze({
    status: "available",
    value: Object.freeze({ date: parsed.value.date, rationale: parsed.value.rationale }),
  });
}
