import { describe, expect, it } from "vitest";

import {
  GitHubCredentialsError,
  GitHubGraphQLReadOnlyViolationError,
  GitHubReadOnlyViolationError,
  SecretRedactor,
  assertReadOnlyGitHubRequest,
  parseGitHubAppCredentials,
  redactSensitiveText,
} from "../src/github/index.js";

const privateKey = [
  "-----BEGIN PRIVATE KEY-----",
  "canary-private-key-material",
  "-----END PRIVATE KEY-----",
].join("\n");

describe("GitHub App認証情報", () => {
  it("専用の環境変数だけを型付き認証情報へ変換する", () => {
    const credentials = parseGitHubAppCredentials({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: privateKey,
      GH_APP_INSTALLATION_ID: "456",
      OTHER_VALUE: "ignored",
    });

    expect(credentials).toEqual({
      appId: 123,
      privateKey,
      installationId: 456,
    });
  });

  it("installation IDを省略できる", () => {
    const credentials = parseGitHubAppCredentials({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: privateKey,
    });

    expect(credentials).toEqual({
      appId: 123,
      privateKey,
    });
  });

  it("不正な値をエラーへ含めない", () => {
    const canary = "private-key-canary";

    expect(() =>
      parseGitHubAppCredentials({
        GH_APP_ID: "invalid-app-id",
        GH_APP_PRIVATE_KEY: canary,
      }),
    ).toThrow(GitHubCredentialsError);

    try {
      parseGitHubAppCredentials({
        GH_APP_ID: "invalid-app-id",
        GH_APP_PRIVATE_KEY: canary,
      });
    } catch (error: unknown) {
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).not.toContain("invalid-app-id");
      expect(error.message).not.toContain(canary);
    }
  });
});

describe("秘匿情報のredaction", () => {
  it("既知のsecret、authorization、token、private key、webhook URLを隠す", () => {
    const knownSecret = "canary-known-secret";
    const source = [
      `secret=${knownSecret}`,
      "Authorization: Bearer bearer-canary-token",
      '{"authorization":"token json-canary-token"}',
      "github=ghs_abcdefghijklmnopqrstuvwxyz0123456789",
      privateKey,
      "webhook=https://discord.com/api/webhooks/1234567890/webhook-canary",
    ].join("\n");

    const redacted = redactSensitiveText(source, [knownSecret]);

    expect(redacted).not.toContain(knownSecret);
    expect(redacted).not.toContain("bearer-canary-token");
    expect(redacted).not.toContain("json-canary-token");
    expect(redacted).not.toContain("ghs_");
    expect(redacted).not.toContain("canary-private-key-material");
    expect(redacted).not.toContain("webhook-canary");
    expect(redacted).toContain("[REDACTED]");
  });

  it("捕捉したエラーのcauseから登録済みtokenを隠す", () => {
    const token = "installation-token-canary";
    const redactor = new SecretRedactor([privateKey, token]);
    const cause = redactor.createSafeCause(
      new Error(`authorization: Bearer ${token}\n${privateKey}`),
    );

    expect(cause.message).not.toContain(token);
    expect(cause.message).not.toContain("canary-private-key-material");
  });
});

describe("GitHub requestの読み取り専用制約", () => {
  const baseUrl = "https://api.github.test";

  it("RESTのGETとHEADを許可する", () => {
    expect(() => {
      assertReadOnlyGitHubRequest(
        {
          method: "GET",
          url: "/repos/VOICEVOX/voicevox/issues",
          baseUrl,
        },
        baseUrl,
        undefined,
      );
    }).not.toThrow();
    expect(() => {
      assertReadOnlyGitHubRequest(
        {
          method: "HEAD",
          url: "/repos/VOICEVOX/voicevox",
          baseUrl,
        },
        baseUrl,
        undefined,
      );
    }).not.toThrow();
  });

  it("RESTの書き込みmethodを拒否する", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => {
        assertReadOnlyGitHubRequest(
          {
            method,
            url: "/repos/VOICEVOX/voicevox/issues/1",
            baseUrl,
          },
          baseUrl,
          undefined,
        );
      }).toThrow(GitHubReadOnlyViolationError);
    }
  });

  it("一致するinstallation token発行POSTだけを許可する", () => {
    expect(() => {
      assertReadOnlyGitHubRequest(
        {
          method: "POST",
          url: "/app/installations/{installation_id}/access_tokens",
          baseUrl,
          installation_id: 456,
        },
        baseUrl,
        456,
      );
    }).not.toThrow();

    expect(() => {
      assertReadOnlyGitHubRequest(
        {
          method: "POST",
          url: "/app/installations/{installation_id}/access_tokens",
          baseUrl,
          installation_id: 457,
        },
        baseUrl,
        456,
      );
    }).toThrow(GitHubReadOnlyViolationError);
  });

  it("GraphQL queryを許可してmutationを拒否する", () => {
    expect(() => {
      assertReadOnlyGitHubRequest(
        {
          method: "POST",
          url: "/graphql",
          baseUrl,
          query: "query { viewer { login } }",
        },
        baseUrl,
        undefined,
      );
    }).not.toThrow();

    expect(() => {
      assertReadOnlyGitHubRequest(
        {
          method: "POST",
          url: "/graphql",
          baseUrl,
          query: "mutation { addComment(input: {}) { clientMutationId } }",
        },
        baseUrl,
        undefined,
      );
    }).toThrow(GitHubGraphQLReadOnlyViolationError);
  });

  it("別originへのリクエストを拒否する", () => {
    expect(() => {
      assertReadOnlyGitHubRequest(
        {
          method: "GET",
          url: "https://example.com/repos/VOICEVOX/voicevox",
          baseUrl,
        },
        baseUrl,
        undefined,
      );
    }).toThrow(GitHubReadOnlyViolationError);
  });
});
