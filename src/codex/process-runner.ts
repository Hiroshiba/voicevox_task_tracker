import { spawn } from "node:child_process";

/** Codex CLI subprocessへ渡す隔離済みの実行情報。 */
export type CodexProcessRequest = Readonly<{
  command: string;
  arguments: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
  standardInput: string;
  timeoutMilliseconds: number;
}>;

/** Codex CLI subprocessの終了状態。 */
export type CodexProcessResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}>;

/** 差し替え可能なCodex CLI subprocess起動関数。 */
export type CodexProcessRunner = (request: CodexProcessRequest) => Promise<CodexProcessResult>;

/** shellを介さずCodex CLI subprocessを起動する。 */
export async function runCodexProcess(request: CodexProcessRequest): Promise<CodexProcessResult> {
  if (!Number.isSafeInteger(request.timeoutMilliseconds) || request.timeoutMilliseconds <= 0) {
    throw new TypeError("timeoutMillisecondsには正の安全な整数を指定してください");
  }

  const child = spawn(request.command, request.arguments, {
    cwd: request.workingDirectory,
    env: request.environment,
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });

  return await new Promise<CodexProcessResult>((resolve, reject) => {
    let timedOut = false;
    let standardInputError:
      | Readonly<{
          status: "none";
        }>
      | Readonly<{
          status: "failed";
          error: Error;
        }> = {
      status: "none",
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMilliseconds);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (exitCode === 0 && standardInputError.status === "failed") {
        reject(standardInputError.error);
        return;
      }
      resolve({
        exitCode,
        signal,
        timedOut,
      });
    });
    child.stdin.once("error", (error) => {
      standardInputError = {
        status: "failed",
        error,
      };
    });
    child.stdin.end(request.standardInput);
  });
}
