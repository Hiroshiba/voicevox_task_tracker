import { describe, expect, it } from "vitest";

import { runCodexProcess } from "../src/codex/index.js";

const subprocessTestTimeoutMilliseconds = 15_000;

describe("Codex subprocess診断", { timeout: subprocessTestTimeoutMilliseconds }, () => {
  it("ERROR JSONからtype、code、statusだけを抽出する", async () => {
    const messageCanary = "MESSAGE_FIELD_CANARY";
    const promptCanary = "PROMPT_CANARY";
    const standardInputCanary = "STANDARD_INPUT_CANARY";
    const childSource = `
IFS= read -r standard_input
printf 'ERROR: {"type":"invalid_request_error","code":"invalid_json_schema","status":400,"message":"%s","prompt":"%s","standardInput":"%s"}' "$2" "$1" "$standard_input" >&2
exit 17
`;

    const result = await runCodexProcess({
      command: "/bin/sh",
      arguments: ["-c", childSource, "codex-process-fixture", promptCanary, messageCanary],
      workingDirectory: import.meta.dirname,
      environment: {},
      standardInput: standardInputCanary,
      timeoutMilliseconds: 5000,
    });

    expect(result).toEqual({
      exitCode: 17,
      signal: null,
      timedOut: false,
      apiError: {
        type: "invalid_request_error",
        code: "invalid_json_schema",
        status: "400",
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(messageCanary);
    expect(serialized).not.toContain(promptCanary);
    expect(serialized).not.toContain(standardInputCanary);
  });

  it("上限を超えるstderrでも末尾のERROR JSONから3項目だけを抽出する", async () => {
    const standardErrorBodyCanary = "OVERSIZED_STANDARD_ERROR_BODY_CANARY";
    const childSource = `
printf '%70000s' '' >&2
printf '%s\n' "$1" >&2
printf 'ERROR: {"type":"invalid_request_error","code":"invalid_json_schema","status":400}' >&2
exit 23
`;

    const result = await runCodexProcess({
      command: "/bin/sh",
      arguments: ["-c", childSource, "codex-process-fixture", standardErrorBodyCanary],
      workingDirectory: import.meta.dirname,
      environment: {},
      standardInput: "",
      timeoutMilliseconds: 5000,
    });

    expect(result).toEqual({
      exitCode: 23,
      signal: null,
      timedOut: false,
      apiError: {
        type: "invalid_request_error",
        code: "invalid_json_schema",
        status: "400",
      },
    });
    expect(JSON.stringify(result)).not.toContain(standardErrorBodyCanary);
  });

  it("ERROR JSONがないstderrでも安全な診断結果を返す", async () => {
    const promptCanary = "PROMPT_WITHOUT_ERROR_JSON_CANARY";
    const standardInputCanary = "STANDARD_INPUT_WITHOUT_ERROR_JSON_CANARY";
    const childSource = `
IFS= read -r standard_input
printf 'prompt=%s\nstdin=%s' "$1" "$standard_input" >&2
exit 19
`;

    const result = await runCodexProcess({
      command: "/bin/sh",
      arguments: ["-c", childSource, "codex-process-fixture", promptCanary],
      workingDirectory: import.meta.dirname,
      environment: {},
      standardInput: standardInputCanary,
      timeoutMilliseconds: 5000,
    });

    expect(result).toEqual({
      exitCode: 19,
      signal: null,
      timedOut: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(promptCanary);
    expect(serialized).not.toContain(standardInputCanary);
  });
});
