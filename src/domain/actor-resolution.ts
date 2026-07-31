/** loginからbotを識別する設定。 */
export type BotLoginRules = Readonly<{
  loginPatterns: readonly string[];
  knownLogins: readonly string[];
  treatAsHuman: readonly string[];
}>;

/** bot判定に必要なGitHubアカウント情報。 */
export type BotPredicateInput = Readonly<{
  login: string;
  apiType: string;
}>;

/** GitHubアカウントをbotとして扱うか判定する関数。 */
export type BotPredicate = (account: BotPredicateInput) => boolean;

function compileLoginPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error: unknown) {
    throw new TypeError(`bot login patternを正規表現として解釈できません: ${pattern}`, {
      cause: error,
    });
  }
}

/** 設定済みloginと正規表現からT08へ渡せるbot判定関数を生成する。 */
export function createGitHubBotPredicate(rules: BotLoginRules): BotPredicate {
  const knownLogins = new Set(rules.knownLogins);
  const treatAsHuman = new Set(rules.treatAsHuman);
  const loginPatterns = rules.loginPatterns.map(compileLoginPattern);

  return (account: BotPredicateInput): boolean => {
    if (treatAsHuman.has(account.login)) {
      return false;
    }
    if (account.apiType === "Bot") {
      return true;
    }
    if (knownLogins.has(account.login)) {
      return true;
    }
    return loginPatterns.some((pattern) => pattern.test(account.login));
  };
}
