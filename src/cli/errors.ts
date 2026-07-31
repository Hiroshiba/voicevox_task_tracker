import { TaskTrackerError } from "../util/index.js";

/** CLIの引数が利用規約へ適合しないことを表す。 */
export class CliUsageError extends TaskTrackerError {
  public constructor(message: string, options: ErrorOptions) {
    super(`CLI引数が不正です。${message}`, options);
  }
}

/** CLIのartifactまたはrun reportを書き出せないことを表す。 */
export class CliOutputError extends TaskTrackerError {
  public constructor(path: string, options: ErrorOptions) {
    super(`CLI出力を書き出せません。対象: ${path}`, options);
  }
}

/** replayまたはevalの入力fixtureを読み取れないことを表す。 */
export class CliFixtureError extends TaskTrackerError {
  public constructor(path: string, options: ErrorOptions) {
    super(`CLI fixtureを読み取れません。対象: ${path}`, options);
  }
}
