import { z } from "zod";

import { ConfigError, type ConfigIssue } from "./config-error.js";
import { assertNonNullable } from "../util/assert-non-nullable.js";

const SUPPORTED_SCHEMA_MAJOR = 1;
const TARGET_ORGANIZATION = "VOICEVOX";
const SUPPORTED_AI_PROVIDER = "codex";
const DEFAULT_HIGH_CONFIDENCE = 0.85;
const DEFAULT_MEDIUM_CONFIDENCE = 0.65;
const SCHEMA_VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)*$/;
const GITHUB_ITEM_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/[1-9]\d*\/?$/u;

const requiredStringSchema = z.string().min(1, "空文字は指定できません");
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nonNegativeNumberSchema = z.number().nonnegative();
const probabilitySchema = z.number().min(0).max(1);

const schemaVersionSchema = z.union([z.string(), z.number()]).transform((value, context) => {
  const version = String(value);
  if (!SCHEMA_VERSION_PATTERN.test(version)) {
    context.addIssue({
      code: "custom",
      message: "1または1.0のようなversionを指定してください",
    });
    return z.NEVER;
  }

  const majorText = version.split(".").at(0);
  assertNonNullable(majorText, "schemaVersionからmajor versionを取得できませんでした");
  const major = Number(majorText);
  if (!Number.isSafeInteger(major)) {
    context.addIssue({
      code: "custom",
      message: "major versionは安全な整数の範囲で指定してください",
    });
    return z.NEVER;
  }
  if (major !== SUPPORTED_SCHEMA_MAJOR) {
    context.addIssue({
      code: "custom",
      message: `major version ${major.toString()}は未対応です。対応しているmajor versionは${SUPPORTED_SCHEMA_MAJOR.toString()}です`,
    });
    return z.NEVER;
  }

  return SUPPORTED_SCHEMA_MAJOR;
});

const organizationSchema = requiredStringSchema.transform((value, context) => {
  if (value !== TARGET_ORGANIZATION) {
    context.addIssue({
      code: "custom",
      message: `${TARGET_ORGANIZATION}を指定してください`,
    });
    return z.NEVER;
  }

  return TARGET_ORGANIZATION;
});

const aiProviderSchema = requiredStringSchema.transform((value, context) => {
  if (value !== SUPPORTED_AI_PROVIDER) {
    context.addIssue({
      code: "custom",
      message: `${value}は未対応です。${SUPPORTED_AI_PROVIDER}を指定してください`,
    });
    return z.NEVER;
  }

  return SUPPORTED_AI_PROVIDER;
});

const teamSlugSchema = z.string().superRefine((value, context) => {
  if (value.trim().length === 0) {
    context.addIssue({
      code: "custom",
      message: "空文字は指定できません",
    });
  } else if (value.startsWith("YOUR_")) {
    context.addIssue({
      code: "custom",
      message: "YOUR_で始まるplaceholderは使用できません",
    });
  }
});

const regexPatternSchema = requiredStringSchema.superRefine((value, context) => {
  try {
    new RegExp(value);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    context.addIssue({
      code: "custom",
      message: "正規表現として解釈できません",
    });
  }
});

const trackingIncludeSchema = requiredStringSchema.superRefine((value, context) => {
  if (value.includes("://") && !GITHUB_ITEM_URL_PATTERN.test(value)) {
    context.addIssue({
      code: "custom",
      message: "GitHub IssueかPull RequestのHTTPS URLまたはnode IDを指定してください",
    });
  } else if (/\s/u.test(value)) {
    context.addIssue({
      code: "custom",
      message: "node IDに空白は使えません",
    });
  }
});

const startAtSchema = z
  .union([
    z.iso.datetime({
      offset: true,
      error: "タイムゾーンを含むISO 8601日時を指定してください",
    }),
    z.null(),
  ])
  .transform((value) => {
    if (typeof value === "string") {
      return new Date(value).toISOString();
    }
    return value;
  });

const teamSchema = z.strictObject({
  org: requiredStringSchema,
  slug: teamSlugSchema,
});

const teamListSchema = z.array(teamSchema).min(1, "teamを1件以上指定してください");

const repositoryTeamsSchema = z.strictObject({
  maintainers: teamListSchema,
  reviewers: teamListSchema,
});

const thresholdSchema = z
  .strictObject({
    watch: nonNegativeNumberSchema,
    urgent: nonNegativeNumberSchema,
    critical: nonNegativeNumberSchema,
  })
  .superRefine((thresholds, context) => {
    if (thresholds.watch > thresholds.urgent) {
      context.addIssue({
        code: "custom",
        path: ["urgent"],
        message: "urgentはwatch以上にしてください",
      });
    }
    if (thresholds.urgent > thresholds.critical) {
      context.addIssue({
        code: "custom",
        path: ["critical"],
        message: "criticalはurgent以上にしてください",
      });
    }
  });

const aiConfidenceSchema = z
  .strictObject({
    high: probabilitySchema.default(DEFAULT_HIGH_CONFIDENCE),
    medium: probabilitySchema.default(DEFAULT_MEDIUM_CONFIDENCE),
  })
  .superRefine((confidence, context) => {
    if (confidence.high < confidence.medium) {
      context.addIssue({
        code: "custom",
        path: ["high"],
        message: "highはmedium以上にしてください",
      });
    }
  });

const labelEffectsSchema = z
  .strictObject({
    priorityWeight: z.number().optional(),
    severityLift: z.number().int().min(0).max(1).optional(),
    requiresMaintainerDecision: z.boolean().optional(),
    suppressNotifications: z.boolean().optional(),
    countsAsProgress: z.boolean().optional(),
  })
  .refine((effects) => Object.keys(effects).length > 0, {
    message: "effectを1件以上指定してください",
  });

const mentionsSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    users: z
      .record(
        requiredStringSchema,
        z.string().regex(/^\d{17,20}$/, "Discord user IDを数字17桁から20桁で指定してください"),
      )
      .default(() => ({})),
  })
  .default(() => ({
    enabled: false,
    users: {},
  }));

const configSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  organization: organizationSchema,
  tracking: z.strictObject({
    startAt: startAtSchema,
    autoInclude: z.strictObject({
      createdAfterStart: z.boolean(),
      changedAfterStart: z.boolean(),
      referencedByTracked: z.boolean(),
      referencesTracked: z.boolean(),
      nativeRelations: z.boolean(),
      relationDepth: nonNegativeIntegerSchema,
    }),
    include: z.array(trackingIncludeSchema),
    retentionDaysAfterTerminal: nonNegativeIntegerSchema,
    backfill: z.strictObject({
      maxItemsPerRun: positiveIntegerSchema,
    }),
  }),
  teams: z.strictObject({
    defaults: z.strictObject({
      maintainers: teamListSchema,
      reviewers: teamListSchema,
    }),
    repositories: z.record(requiredStringSchema, repositoryTeamsSchema),
  }),
  actors: z.strictObject({
    bots: z.strictObject({
      loginPatterns: z.array(regexPatternSchema),
      knownLogins: z.array(requiredStringSchema),
      treatAsHuman: z.array(requiredStringSchema),
    }),
  }),
  labels: z.strictObject({
    rules: z.array(
      z.strictObject({
        repository: requiredStringSchema,
        namePattern: regexPatternSchema,
        effects: labelEffectsSchema,
      }),
    ),
  }),
  staleness: z.strictObject({
    timezone: requiredStringSchema,
    recentProgressGraceHours: nonNegativeNumberSchema,
    thresholdsHours: z.strictObject({
      maintainerTriage: thresholdSchema,
      ownerUnknown: thresholdSchema,
      reviewer: thresholdSchema,
      authorAfterChangesRequested: thresholdSchema,
      assigneeOrInProgress: thresholdSchema,
      readyToMerge: thresholdSchema,
      automation: thresholdSchema,
    }),
  }),
  ai: z
    .strictObject({
      provider: aiProviderSchema,
      enabled: z.boolean(),
      model: requiredStringSchema,
      promptVersion: requiredStringSchema,
      schemaPath: requiredStringSchema,
      confidence: aiConfidenceSchema.default({
        high: DEFAULT_HIGH_CONFIDENCE,
        medium: DEFAULT_MEDIUM_CONFIDENCE,
      }),
      budget: z.strictObject({
        maxCallsPerRun: nonNegativeIntegerSchema,
        maxInputCharactersPerItem: positiveIntegerSchema,
        maxTotalInputCharactersPerRun: positiveIntegerSchema,
        maxEstimatedCostUsdPerRun: nonNegativeNumberSchema,
      }),
      execution: z.strictObject({
        timeoutSeconds: positiveIntegerSchema,
        maxAttempts: positiveIntegerSchema,
        sandbox: z.literal("read-only"),
        approvalPolicy: z.literal("never"),
      }),
    })
    .superRefine((ai, context) => {
      if (ai.enabled && ai.model.startsWith("YOUR_")) {
        context.addIssue({
          code: "custom",
          path: ["model"],
          message: "YOUR_で始まるplaceholderは使用できません",
        });
      }
    }),
  notifications: z.strictObject({
    discord: z.strictObject({
      enabled: z.boolean(),
      webhookSecretName: requiredStringSchema,
      operationsWebhookSecretName: requiredStringSchema,
      mentions: mentionsSchema,
      maxItemsPerDigest: positiveIntegerSchema,
      cooldownDays: z.strictObject({
        urgent: nonNegativeIntegerSchema,
        critical: nonNegativeIntegerSchema,
      }),
      silenceWhenEmpty: z.boolean(),
    }),
  }),
  state: z.strictObject({
    branch: requiredStringSchema,
    snapshotPath: requiredStringSchema,
    historyDirectory: requiredStringSchema,
    aiCacheDirectory: requiredStringSchema,
    notificationLedgerPath: requiredStringSchema,
    canonicalJson: z.boolean(),
  }),
  web: z.strictObject({
    basePath: requiredStringSchema,
    title: requiredStringSchema,
    defaultLocale: requiredStringSchema,
    graph: z.strictObject({
      maxInitialNodes: positiveIntegerSchema,
      clusterByRepository: z.boolean(),
    }),
  }),
  operations: z.strictObject({
    githubApiBudgetRatio: probabilitySchema,
    failOnPrivateDataGuard: z.boolean(),
    publishPartialData: z.boolean(),
    retry: z.strictObject({
      maxAttempts: positiveIntegerSchema,
      initialDelaySeconds: nonNegativeNumberSchema,
      maxDelaySeconds: nonNegativeNumberSchema,
    }),
  }),
});

export type Config = z.output<typeof configSchema>;

function formatPath(path: readonly PropertyKey[]): string {
  let formattedPath = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formattedPath += `[${segment.toString()}]`;
    } else {
      const separator = formattedPath.length === 0 ? "" : ".";
      formattedPath += `${separator}${String(segment)}`;
    }
  }
  return formattedPath.length === 0 ? "設定全体" : formattedPath;
}

function createConfigIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

/** 未検証の値を型付き設定へ変換する。 */
export function validateConfig(value: unknown): Config {
  const result = configSchema.safeParse(value, {
    error: z.locales.ja().localeError,
  });
  if (!result.success) {
    throw new ConfigError(createConfigIssues(result.error), {});
  }
  return result.data;
}
