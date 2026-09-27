import type {
  GenericAiElementAdoption,
  GenericAiItemAdoption,
} from "./generic-ai-adoption-contracts.js";
import type { z } from "zod";
import {
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElementReuseProof,
} from "../../../domain/ai-analysis-elements.js";
import { createAiAnalysisElementSourceGenerationSchema } from "../../../domain/ai-analysis-source-generations.js";
import type { TrackedItemAiAnalysis } from "../../../domain/index.js";

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

/** 採用記録から項目値に保存する生成元と適用元を投影する。 */
export function trackedItemAiAnalysisFromAdoption(
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
