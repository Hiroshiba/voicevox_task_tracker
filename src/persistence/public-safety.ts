import { StateConfigurationError, StatePublicSafetyError } from "./errors.js";
import { type StateSnapshot } from "./snapshot.js";
import { type Repository } from "../domain/index.js";
import { createPublicRepositoryAllowlist, isEligiblePublicRepository } from "../github/index.js";

const MAX_PERSISTED_STRING_LENGTH = 4096;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/iu,
  /\bauthorization\b\s*[:=]\s*(?:basic|bearer|token)\s+\S+/iu,
  /\b(?:github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,})\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/u,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/iu,
] as const;
const CREDENTIAL_FIELD_NAMES = new Set([
  "accesstoken",
  "authorization",
  "credential",
  "credentials",
  "discordwebhookurl",
  "githubtoken",
  "installationtoken",
  "openaiapikey",
  "password",
  "privatekey",
  "rawtoken",
  "secret",
  "token",
  "webhookurl",
]);
const FULL_CONTENT_FIELD_NAMES = new Set([
  "apiresponse",
  "body",
  "bodytext",
  "comment",
  "commentbody",
  "comments",
  "content",
  "rawbody",
  "rawcontent",
  "rawresponse",
  "responsetext",
  "text",
]);

/** state公開安全性検証へ渡すrun内の独立入力。 */
export type StatePublicSafetyInput = Readonly<{
  snapshot: StateSnapshot;
  repositoryInventory: readonly Repository[];
  additionalValues: readonly unknown[];
  knownSecrets: readonly string[];
}>;

function normalizedFieldName(value: string): string {
  return value.replaceAll(/[-_]/gu, "").toLowerCase();
}

function includesKnownValue(value: string, knownValues: readonly string[]): boolean {
  return knownValues.some((knownValue) => value.includes(knownValue));
}

function includesSecretPattern(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function scanValues(
  values: readonly unknown[],
  privateRepositoryIds: readonly string[],
  knownSecrets: readonly string[],
): readonly string[] {
  const violationCodes = new Set<string>();
  const pending: unknown[] = [...values];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (includesKnownValue(value, privateRepositoryIds)) {
        violationCodes.add("private_repository_data");
      }
      if (includesKnownValue(value, knownSecrets) || includesSecretPattern(value)) {
        violationCodes.add("secret");
      }
      if (value.length > MAX_PERSISTED_STRING_LENGTH) {
        violationCodes.add("unnecessary_full_content");
      }
      continue;
    }
    if (typeof value !== "object" || value == null || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isUnknownArray(value)) {
      pending.push(...value);
      continue;
    }

    for (const [key, propertyValue] of Object.entries(value)) {
      const fieldName = normalizedFieldName(key);
      if (CREDENTIAL_FIELD_NAMES.has(fieldName)) {
        violationCodes.add("credential_field");
      }
      if (FULL_CONTENT_FIELD_NAMES.has(fieldName)) {
        violationCodes.add("unnecessary_full_content");
      }
      if (includesKnownValue(key, knownSecrets) || includesSecretPattern(key)) {
        violationCodes.add("secret");
      }
      pending.push(propertyValue);
    }
  }

  return Object.freeze([...violationCodes]);
}

/** 直列化直前に公開allowlistとsecret・全文転載制約を独立検証する。 */
export function assertStatePublicSafety(input: StatePublicSafetyInput): void {
  for (const secret of input.knownSecrets) {
    if (secret.length === 0) {
      throw new StateConfigurationError("knownSecretsに空文字は指定できません");
    }
  }

  const allowlist = createPublicRepositoryAllowlist(input.repositoryInventory);
  const violationCodes: string[] = [];
  for (const repository of input.snapshot.repositories) {
    if (!allowlist.has(repository.id)) {
      violationCodes.push("repository_not_allowlisted");
    }
  }
  for (const item of input.snapshot.items) {
    if (!allowlist.has(item.repositoryId)) {
      violationCodes.push("repository_not_allowlisted");
    }
  }

  const privateRepositoryIds = input.repositoryInventory
    .filter((repository) => !isEligiblePublicRepository(repository))
    .map((repository) => repository.id);
  violationCodes.push(
    ...scanValues(
      [input.snapshot, ...input.additionalValues],
      privateRepositoryIds,
      input.knownSecrets,
    ),
  );

  if (violationCodes.length > 0) {
    throw new StatePublicSafetyError(violationCodes);
  }
}
