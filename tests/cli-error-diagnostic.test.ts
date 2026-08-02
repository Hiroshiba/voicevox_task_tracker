import { z } from "zod";
import { describe, expect, it } from "vitest";

import { safeErrorDiagnostic } from "../src/cli/error-diagnostic.js";
import {
  CliCodexAuthenticationError,
  CliCredentialsError,
  CliExecutableError,
} from "../src/cli/errors.js";
import {
  GitHubGraphQLResponseError,
  GitHubRequestError,
  GitHubResponseSchemaValidationError,
} from "../src/github/index.js";

class GitHubItemDetailError extends Error {
  public constructor(cause: Error) {
    super("GitHub項目の詳細取得に失敗しました", { cause });
    this.name = new.target.name;
  }
}

function createGraphQLResponseError(options: ErrorOptions): GitHubGraphQLResponseError {
  return new GitHubGraphQLResponseError(
    {
      operationName: "GitHubItemDetail",
      queryHash: "3f2a1c9d8e7b6a54",
      errorCount: 1,
      errors: [
        {
          locations: [{ line: 634, column: 13 }],
          path: ["node", "autoMergeRequest", "id"],
          type: "INVALID",
          code: "undefinedField",
          fieldName: "id",
          typeName: "AutoMergeRequest",
        },
      ],
      requestId: "ABCD:1234:5678",
    },
    options,
  );
}

describe("safeErrorDiagnostic", () => {
  it("causeを持たないエラーから発生位置を出す", () => {
    const error = new TypeError("GitHub由来メッセージ");
    error.stack = [
      "TypeError: GitHub由来メッセージ",
      "    at detectProgress (file:///srv/voicevox_task_tracker/dist/domain/meaningful-progress.js:182:23)",
    ].join("\n");

    expect(safeErrorDiagnostic("incremental_collection", error)).toBe(
      "stage=incremental_collection errorType=TypeError errorSite0=meaningful-progress.js:182",
    );
  });

  it("cause連鎖の順に各エラーの発生位置を出す", () => {
    const cause = new RangeError("cause");
    cause.stack = [
      "RangeError: cause",
      "    at buildGraph (file:///srv/voicevox_task_tracker/src/graph/task-graph.ts:41:9)",
    ].join("\n");
    const error = new TypeError("error", { cause });
    error.stack = [
      "TypeError: error",
      "    at runTracker (file:///srv/voicevox_task_tracker/dist/cli/tracker-run.js:230:15)",
    ].join("\n");

    expect(safeErrorDiagnostic("incremental_collection", error)).toBe(
      "stage=incremental_collection errorType=TypeError<-RangeError errorSite0=tracker-run.js:230 errorSite1=task-graph.ts:41",
    );
  });

  it("node_modulesやnode:internalだけのstackから発生位置を出さない", () => {
    const error = new TypeError("fixture");
    error.stack = [
      "TypeError: fixture",
      "    at dependency (file:///srv/voicevox_task_tracker/node_modules/example/dist/index.js:12:4)",
      "    at processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ].join("\n");

    expect(safeErrorDiagnostic("incremental_collection", error)).toBe(
      "stage=incremental_collection errorType=TypeError",
    );
  });

  it("診断文字列へディレクトリパスやユーザー名を出さない", () => {
    const userName = "private-user-canary";
    const directoryName = "secret-directory-canary";
    const githubMessage = "github-message-canary";
    const error = new Error(githubMessage);
    error.stack = [
      `Error: ${githubMessage}`,
      `    at ${userName} (file:///home/${userName}/${directoryName}/src/cli/tracker-run.ts:73:9)`,
    ].join("\n");

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toBe(
      "stage=incremental_collection errorType=Error errorSite0=tracker-run.ts:73",
    );
    expect(diagnostic).not.toContain(userName);
    expect(diagnostic).not.toContain(directoryName);
    expect(diagnostic).not.toContain(githubMessage);
  });

  it("causeで包まれたGraphQLレスポンスエラーの型と安全な詳細を出す", () => {
    const rawMessage = "Field 'id' doesn't exist on type 'AutoMergeRequest'";
    const variables = "variables-canary";
    const responseBody = "response-body-canary";
    const query = "query-body-canary";
    const graphQLError = createGraphQLResponseError({
      cause: new Error([rawMessage, variables, responseBody, query].join("|")),
    });
    const error = new GitHubItemDetailError(graphQLError);

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toBe(
      "stage=incremental_collection errorType=GitHubItemDetailError<-GitHubGraphQLResponseError<-Error operation=GitHubItemDetail queryHash=3f2a1c9d8e7b6a54 gqlErrorCount=1 gqlError0Locations=line:634,column:13 gqlError0Path=node.autoMergeRequest.id gqlError0Type=INVALID gqlError0Code=undefinedField gqlError0Field=id gqlError0ParentType=AutoMergeRequest requestId=ABCD:1234:5678",
    );
    expect(diagnostic).not.toContain("httpStatus=");
    expect(diagnostic).not.toContain(rawMessage);
    expect(diagnostic).not.toContain(variables);
    expect(diagnostic).not.toContain(responseBody);
    expect(diagnostic).not.toContain(query);
  });

  it("空白や改行を含む診断値を出さない", () => {
    const error = new GitHubGraphQLResponseError(
      {
        queryHash: "0123456789abcdef",
        errorCount: 1,
        errors: [
          {
            locations: [{ line: 1, column: 2 }],
            path: ["unsafe path"],
            type: "unsafe type",
            code: "unsafe\ncode",
            fieldName: "safeField",
            typeName: "SafeType",
          },
        ],
        requestId: "unsafe request\nid",
      },
      {},
    );

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).not.toContain("gqlError0Path=");
    expect(diagnostic).not.toContain("gqlError0Type=");
    expect(diagnostic).not.toContain("gqlError0Code=");
    expect(diagnostic).not.toContain("requestId=");
    expect(diagnostic).not.toMatch(/[\n\r\t]/u);
    for (const field of diagnostic.split(" ")) {
      const separatorIndex = field.indexOf("=");
      expect(separatorIndex).toBeGreaterThan(0);
      expect(field.slice(separatorIndex + 1)).not.toMatch(/[\s\p{Cc}]/u);
    }
  });

  it("空白や改行を含むエラー型名を出さない", () => {
    const error = new Error("fixture");
    error.name = "Unsafe Error\nType";

    expect(safeErrorDiagnostic("configuration", error)).toBe("stage=configuration");
  });

  it("causeが循環していても各エラーを1回だけ出す", () => {
    const first = new Error("first");
    const second = new TypeError("second", { cause: first });
    Object.defineProperty(first, "cause", { value: second });

    expect(safeErrorDiagnostic("configuration", first)).toBe(
      "stage=configuration errorType=Error<-TypeError",
    );
  });

  it("causeチェーンを先頭5件まで出す", () => {
    let error = new Error("sixth");
    for (let index = 5; index >= 1; index -= 1) {
      error = new Error(index.toString(), { cause: error });
    }

    expect(safeErrorDiagnostic("configuration", error)).toBe(
      "stage=configuration errorType=Error<-Error<-Error<-Error<-Error",
    );
  });

  it("GraphQLエラー詳細を先頭3件に制限して超過件数を出す", () => {
    const error = new GitHubGraphQLResponseError(
      {
        queryHash: "0123456789abcdef",
        errorCount: 4,
        errors: [
          { fieldName: "field0" },
          { fieldName: "field1" },
          { fieldName: "field2" },
          { fieldName: "field3" },
        ],
      },
      {},
    );

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toContain("gqlError2Field=field2");
    expect(diagnostic).not.toContain("gqlError3Field=field3");
    expect(diagnostic).toContain("gqlErrorOmittedCount=1");
  });

  it("診断文字列の長さ上限で打ち切り、後続フィールドを省略する", () => {
    const error = new GitHubGraphQLResponseError(
      {
        operationName: `Operation${"A".repeat(291)}`,
        queryHash: "0123456789abcdef",
        errorCount: 1,
        errors: [
          {
            path: ["p".repeat(300)],
            type: "T".repeat(300),
            code: "must-not-appear",
          },
        ],
        requestId: "must-not-appear",
      },
      {},
    );

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic.length).toBeLessThanOrEqual(1000);
    expect(diagnostic).toMatch(/ truncated=true$/u);
    expect(diagnostic).not.toContain("gqlError0Code=");
    expect(diagnostic).not.toContain("requestId=");
  });

  it("Zod issueを先頭5件に制限してpath、code、期待型と超過件数を出す", () => {
    const result = z.array(z.string()).safeParse([0, 1, 2, 3, 4, 5]);
    if (result.success) {
      throw new TypeError("Zod検証が成功しました");
    }
    const error = new GitHubResponseSchemaValidationError("fixture", result.error);

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toContain("errorType=GitHubResponseSchemaValidationError<-TypeError");
    expect(diagnostic).toContain("zodIssueCount=6");
    expect(diagnostic).toContain("zodIssue0Path=0");
    expect(diagnostic).toContain("zodIssue0Code=invalid_type");
    expect(diagnostic).toContain("zodIssue0Expected=string");
    expect(diagnostic).toContain("zodIssue4Path=4");
    expect(diagnostic).not.toContain("zodIssue5Path=5");
    expect(diagnostic).toContain("zodIssueOmittedCount=1");
  });

  it("許可済みCLIエラー3種でmessageを最後に出す", () => {
    const errors = [
      new CliCodexAuthenticationError({}),
      new CliCredentialsError(["GH_APP_ID", "GH_APP_PRIVATE_KEY"], {}),
      new CliExecutableError("codex", {}),
    ];

    for (const error of errors) {
      const diagnostic = safeErrorDiagnostic("configuration", error);
      expect(diagnostic).toContain(`errorType=${error.name}`);
      expect(diagnostic.indexOf(" message=")).toBeGreaterThan(diagnostic.indexOf(" errorType="));
      expect(diagnostic.slice(diagnostic.indexOf(" message=") + 1)).toBe(
        `message=${error.message}`,
      );
    }
  });

  it("許可済みmessageの空白を保ち、改行と制御文字だけをエスケープする", () => {
    const error = new CliExecutableError("co dex\n\t\u0000", {});

    expect(safeErrorDiagnostic("configuration", error)).toBe(
      "stage=configuration errorType=CliExecutableError message=必要な実行可能ファイルが見つからないか起動できません。対象: co dex%u000a%u0009%u0000",
    );
  });

  it("既知のcause詳細より後にmessageを出す", () => {
    const cause = new GitHubRequestError(503, 2, {});
    const error = new CliExecutableError("codex", { cause });

    expect(safeErrorDiagnostic("configuration", error)).toBe(
      "stage=configuration errorType=CliExecutableError<-GitHubRequestError attempts=2 httpStatus=503 message=必要な実行可能ファイルが見つからないか起動できません。対象: codex",
    );
  });
});
