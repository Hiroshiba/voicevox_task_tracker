import { hashCanonicalJson } from "../../dist/canonical-json/index.js";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function verifiedSnapshotReuses(firstItems, secondItems, firstGeneratedAt) {
  const firstByNodeId = new Map(firstItems.map((item) => [item.nodeId, item]));
  const matches = [];
  for (const secondItem of secondItems) {
    const firstItem = firstByNodeId.get(secondItem.nodeId);
    if (firstItem == null) {
      continue;
    }
    for (const [element, secondApplication] of Object.entries(secondItem.aiAnalysis.applications)) {
      if (
        secondApplication.status !== "current_ai" ||
        secondApplication.origin !== "verified_reuse" ||
        firstItem.aiAnalysis.applications[element]?.status !== "current_ai" ||
        firstItem.aiAnalysis.applications[element].origin !== "executed"
      ) {
        continue;
      }
      const firstAdopted = firstItem.aiAnalysis.adoptedElements[element];
      const firstEvaluated = firstItem.aiAnalysis.elements[element];
      const secondAdopted = secondItem.aiAnalysis.adoptedElements[element];
      if (
        firstAdopted?.origin !== "current" ||
        firstEvaluated == null ||
        secondAdopted?.origin !== "current" ||
        firstAdopted.reuseProof.status !== "verified" ||
        secondAdopted.reuseProof.status !== "verified" ||
        firstAdopted.generation.metadata.generatedAt !== firstGeneratedAt ||
        canonicalJson(firstAdopted.generation) !== canonicalJson(firstEvaluated.generation) ||
        firstAdopted.generation.metadata.inputFingerprint !==
          secondAdopted.generation.metadata.inputFingerprint ||
        firstAdopted.reuseProof.inputFingerprint !==
          firstAdopted.generation.metadata.inputFingerprint ||
        canonicalJson(firstAdopted.reuseProof) !== canonicalJson(secondAdopted.reuseProof) ||
        canonicalJson(firstAdopted.generation) !== canonicalJson(secondAdopted.generation) ||
        canonicalJson(firstAdopted.result) !== canonicalJson(secondAdopted.result)
      ) {
        throw new TypeError("second runのsnapshot再利用証拠がfirstの採用結果と一致しません");
      }
      matches.push({
        nodeId: secondItem.nodeId,
        element,
        inputFingerprint: firstAdopted.reuseProof.inputFingerprint,
      });
    }
  }
  return matches;
}

/** secondの実計画と保存結果から別nodeのsnapshot再利用証人を選ぶ。 */
export function plannedSnapshotReuseWitness(
  firstItems,
  secondItems,
  firstGeneratedAt,
  choices,
  cacheNodeId,
) {
  const plannedChoices = new Map(
    choices.map((choice) => [JSON.stringify([choice.nodeId, choice.element]), choice]),
  );
  const snapshotReuses = verifiedSnapshotReuses(firstItems, secondItems, firstGeneratedAt).filter(
    (reuse) => {
      const planned = plannedChoices.get(JSON.stringify([reuse.nodeId, reuse.element]));
      return (
        planned?.choice === "snapshot_reuse" && planned.inputFingerprint === reuse.inputFingerprint
      );
    },
  );
  const plannedWitness = snapshotReuses.find((reuse) => reuse.nodeId !== cacheNodeId);
  if (plannedWitness == null) {
    throw new TypeError("second runの別nodeで計画済みsnapshot再利用を確認できません");
  }
  return {
    snapshotReuses,
    snapshotReuseWitness: { ...plannedWitness, choice: "snapshot_reuse" },
  };
}

/** firstの実AI採用値がsecondで指定どおりcache採用されたことを照合する。 */
export function verifyCacheProbeAdoption(firstItems, secondItems, probe) {
  const firstCacheItem = firstItems.find((item) => item.nodeId === probe.nodeId);
  const secondCacheItem = secondItems.find((item) => item.nodeId === probe.nodeId);
  if (firstCacheItem == null || secondCacheItem == null) {
    throw new TypeError("second runのcache probe対象nodeがありません");
  }
  let adoptedCacheCount = 0;
  for (const expected of probe.elements) {
    const firstEvaluated = firstCacheItem.aiAnalysis.elements[expected.element];
    const secondEvaluated = secondCacheItem.aiAnalysis.elements[expected.element];
    const firstApplication = firstCacheItem.aiAnalysis.applications[expected.element];
    const secondApplication = secondCacheItem.aiAnalysis.applications[expected.element];
    if (
      firstEvaluated == null ||
      secondEvaluated == null ||
      firstEvaluated.generation.metadata.inputFingerprint !== expected.inputFingerprint ||
      hashCanonicalJson(firstEvaluated.generation) !== expected.generationDigest ||
      canonicalJson(firstEvaluated.generation) !== canonicalJson(secondEvaluated.generation)
    ) {
      throw new TypeError("second runのcache結果がfirstの生成値と一致しません");
    }
    if (firstApplication?.status === "current_ai" && firstApplication.origin === "executed") {
      if (secondApplication?.status !== "current_ai" || secondApplication.origin !== "cache") {
        throw new TypeError("second runでfirstの実AI結果をcache採用できません");
      }
      adoptedCacheCount += 1;
    }
  }
  if (adoptedCacheCount < 1) {
    throw new TypeError("second runにfirstの実file cache採用がありません");
  }
  return adoptedCacheCount;
}
