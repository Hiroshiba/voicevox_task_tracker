import { createHash } from "node:crypto";

import { GraphqlResponseError } from "@octokit/graphql";
import {
  Kind,
  OperationTypeNode,
  parse,
  print,
  type DefinitionNode,
  type DocumentNode,
  type FieldNode,
  type OperationDefinitionNode,
} from "graphql";
import { z } from "zod";

import {
  GitHubGraphQLDocumentError,
  GitHubGraphQLReadOnlyViolationError,
  GitHubGraphQLResponseError,
  GitHubResponseSchemaValidationError,
  type GitHubGraphQLErrorDiagnostic,
  type GitHubGraphQLResponseDiagnostics,
} from "./errors.js";
import { graphQLRateLimitSchema, type GraphQLRateLimit } from "./rate-limit.js";
import { SecretRedactor } from "./redaction.js";

const RATE_LIMIT_ALIAS = "voicevoxTaskTrackerRateLimit";

const graphQLIdentifierSchema = z.string().regex(/^[_A-Za-z][_0-9A-Za-z]*$/u);
const graphQLErrorLocationsSchema = z.array(
  z.object({
    line: z.number().int().positive(),
    column: z.number().int().positive(),
  }),
);
const graphQLErrorPathSchema = z.array(z.union([z.string(), z.number()]));
const graphQLErrorCollectionSchema = z.array(z.unknown());
const diagnosticStringSchema = z.string().min(1);
const fieldTypeReferenceSchema = z.tuple([graphQLIdentifierSchema, graphQLIdentifierSchema]);
const FIELD_TYPE_MESSAGE_PATTERN = /^Field '([^']+)' doesn't exist on type '([^']+)'$/u;

const rateLimitField = {
  kind: Kind.FIELD,
  alias: {
    kind: Kind.NAME,
    value: RATE_LIMIT_ALIAS,
  },
  name: {
    kind: Kind.NAME,
    value: "rateLimit",
  },
  selectionSet: {
    kind: Kind.SELECTION_SET,
    selections: ["cost", "limit", "remaining", "resetAt"].map((name) => ({
      kind: Kind.FIELD,
      name: {
        kind: Kind.NAME,
        value: name,
      },
    })),
  },
} satisfies FieldNode;

const graphQLResponseSchema = z.record(z.string(), z.unknown());

type GraphQLExecutor = (
  query: string,
  variables: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

function parseGraphQLDocument(query: string): DocumentNode {
  try {
    return parse(query);
  } catch (error: unknown) {
    throw new GitHubGraphQLDocumentError({
      cause: new SyntaxError("GraphQL文書の構文が不正です", {
        cause: error,
      }),
    });
  }
}

function hasReservedAlias(operation: OperationDefinitionNode): boolean {
  return operation.selectionSet.selections.some(
    (selection) =>
      selection.kind === Kind.FIELD &&
      (selection.alias?.value ?? selection.name.value) === RATE_LIMIT_ALIAS,
  );
}

function instrumentDefinition(definition: DefinitionNode): DefinitionNode {
  if (definition.kind !== Kind.OPERATION_DEFINITION) {
    return definition;
  }
  if (definition.operation !== OperationTypeNode.QUERY) {
    throw new GitHubGraphQLReadOnlyViolationError();
  }
  if (hasReservedAlias(definition)) {
    throw new GitHubGraphQLDocumentError({
      cause: new TypeError("予約済みのGraphQL aliasが使われています"),
    });
  }

  const instrumented = {
    ...definition,
    selectionSet: {
      ...definition.selectionSet,
      selections: [...definition.selectionSet.selections, rateLimitField],
    },
  } satisfies OperationDefinitionNode;
  return instrumented;
}

function extractOperationName(document: DocumentNode): string | undefined {
  let operationCount = 0;
  let operationNameValue: unknown;
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) {
      continue;
    }
    operationCount += 1;
    operationNameValue = definition.name?.value;
  }
  if (operationCount !== 1) {
    return undefined;
  }
  const result = graphQLIdentifierSchema.safeParse(operationNameValue);
  return result.success ? result.data : undefined;
}

function createQueryHash(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex").slice(0, 16);
}

function extractFieldTypeReference(message: unknown): Readonly<{
  fieldName?: string;
  typeName?: string;
}> {
  const messageResult = z.string().safeParse(message);
  if (!messageResult.success) {
    return {};
  }
  const match = FIELD_TYPE_MESSAGE_PATTERN.exec(messageResult.data);
  const referenceResult = fieldTypeReferenceSchema.safeParse(match?.slice(1));
  if (!referenceResult.success) {
    return {};
  }
  return {
    fieldName: referenceResult.data[0],
    typeName: referenceResult.data[1],
  };
}

function extractGraphQLErrorDiagnostic(value: unknown): GitHubGraphQLErrorDiagnostic | undefined {
  const errorResult = graphQLResponseSchema.safeParse(value);
  if (!errorResult.success) {
    return undefined;
  }
  const locationsResult = graphQLErrorLocationsSchema.safeParse(errorResult.data["locations"]);
  const pathResult = graphQLErrorPathSchema.safeParse(errorResult.data["path"]);
  const typeResult = diagnosticStringSchema.safeParse(errorResult.data["type"]);
  const extensionsResult = graphQLResponseSchema.safeParse(errorResult.data["extensions"]);
  const codeResult = diagnosticStringSchema.safeParse(
    extensionsResult.success ? extensionsResult.data["code"] : undefined,
  );
  const fieldTypeReference = extractFieldTypeReference(errorResult.data["message"]);
  const diagnostic = {
    ...(locationsResult.success ? { locations: locationsResult.data } : {}),
    ...(pathResult.success ? { path: pathResult.data } : {}),
    ...(typeResult.success ? { type: typeResult.data } : {}),
    ...(codeResult.success ? { code: codeResult.data } : {}),
    ...fieldTypeReference,
  } satisfies GitHubGraphQLErrorDiagnostic;
  return Object.keys(diagnostic).length === 0 ? undefined : diagnostic;
}

function createGraphQLResponseError(
  error: GraphqlResponseError<unknown>,
  document: DocumentNode,
  query: string,
  redactor: SecretRedactor,
): GitHubGraphQLResponseError {
  const errorsResult = graphQLErrorCollectionSchema.safeParse(error.errors);
  const rawErrors = errorsResult.success ? errorsResult.data : [];
  const errors = rawErrors.flatMap((rawError) => {
    const diagnostic = extractGraphQLErrorDiagnostic(rawError);
    return diagnostic == null ? [] : [diagnostic];
  });
  const operationName = extractOperationName(document);
  const requestIdResult = diagnosticStringSchema.safeParse(error.headers["x-github-request-id"]);
  const diagnostics = {
    ...(operationName == null ? {} : { operationName }),
    queryHash: createQueryHash(query),
    errorCount: rawErrors.length,
    errors,
    ...(requestIdResult.success ? { requestId: requestIdResult.data } : {}),
  } satisfies GitHubGraphQLResponseDiagnostics;
  const cause = redactor.createSafeCause(error);
  return new GitHubGraphQLResponseError(diagnostics, { cause });
}

/** GraphQL文書がqueryだけで構成されていることを確認する。 */
export function assertReadOnlyGraphQL(query: string): void {
  const document = parseGraphQLDocument(query);
  for (const definition of document.definitions) {
    if (
      definition.kind === Kind.OPERATION_DEFINITION &&
      definition.operation !== OperationTypeNode.QUERY
    ) {
      throw new GitHubGraphQLReadOnlyViolationError();
    }
  }
}

/** 読み取り専用GraphQL文書を計装して実行し、GraphQLレスポンスエラーを安全に変換する。 */
export async function executeReadOnlyGraphQL(
  query: string,
  variables: Readonly<Record<string, unknown>>,
  execute: GraphQLExecutor,
  redactor: SecretRedactor,
): Promise<unknown> {
  const document = parseGraphQLDocument(query);
  const instrumentedDocument = {
    ...document,
    definitions: document.definitions.map(instrumentDefinition),
  } satisfies DocumentNode;
  const instrumentedQuery = print(instrumentedDocument);
  try {
    return await execute(instrumentedQuery, variables);
  } catch (error: unknown) {
    if (!(error instanceof GraphqlResponseError)) {
      throw error;
    }
    throw createGraphQLResponseError(error, instrumentedDocument, instrumentedQuery, redactor);
  }
}

/** GraphQLレスポンスからrate limitを分離する。 */
export function extractGraphQLRateLimit(response: unknown): Readonly<{
  data: Readonly<Record<string, unknown>>;
  rateLimit: GraphQLRateLimit;
}> {
  const result = graphQLResponseSchema.safeParse(response);
  if (!result.success) {
    throw new GitHubResponseSchemaValidationError("GraphQL response", result.error);
  }

  const rateLimitResult = graphQLRateLimitSchema.safeParse(result.data[RATE_LIMIT_ALIAS]);
  if (!rateLimitResult.success) {
    throw new GitHubResponseSchemaValidationError("GraphQL rateLimit", rateLimitResult.error);
  }

  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.data)) {
    if (key !== RATE_LIMIT_ALIAS) {
      data[key] = value;
    }
  }
  return {
    data,
    rateLimit: rateLimitResult.data,
  };
}
