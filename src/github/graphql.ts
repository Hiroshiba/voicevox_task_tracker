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
  GitHubResponseValidationError,
} from "./errors.js";
import { graphQLRateLimitSchema, type GraphQLRateLimit } from "./rate-limit.js";

const RATE_LIMIT_ALIAS = "voicevoxTaskTrackerRateLimit";

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

function parseGraphQLDocument(query: string): DocumentNode {
  try {
    return parse(query);
  } catch {
    throw new GitHubGraphQLDocumentError({
      cause: new SyntaxError("GraphQL文書の構文が不正です"),
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

/** 読み取り専用GraphQL文書へrate limit監視用fieldを追加する。 */
export function instrumentReadOnlyGraphQL(query: string): string {
  const document = parseGraphQLDocument(query);
  const instrumentedDocument = {
    ...document,
    definitions: document.definitions.map(instrumentDefinition),
  } satisfies DocumentNode;
  return print(instrumentedDocument);
}

/** GraphQLレスポンスからrate limitを分離する。 */
export function extractGraphQLRateLimit(response: unknown): Readonly<{
  data: Readonly<Record<string, unknown>>;
  rateLimit: GraphQLRateLimit;
}> {
  const result = graphQLResponseSchema.safeParse(response);
  if (!result.success) {
    throw new GitHubResponseValidationError("GraphQL response", {
      cause: new TypeError("GraphQL responseがobjectではありません"),
    });
  }

  const rateLimitResult = graphQLRateLimitSchema.safeParse(result.data[RATE_LIMIT_ALIAS]);
  if (!rateLimitResult.success) {
    throw new GitHubResponseValidationError("GraphQL rateLimit", {
      cause: new TypeError("GraphQL rateLimitが不足または不正です"),
    });
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
