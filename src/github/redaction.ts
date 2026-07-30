const REDACTED = "[REDACTED]";
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/gu;
const QUOTED_AUTHORIZATION_PATTERN = /(\b["']?authorization["']?\s*[:=]\s*)(["'])[\s\S]*?\2/giu;
const AUTHORIZATION_HEADER_PATTERN =
  /(\bauthorization\b\s*[:=]\s*)(?:basic|bearer|token)\s+[^\s,;}\]]+/giu;
const GITHUB_TOKEN_PATTERN = /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/gu;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const DISCORD_WEBHOOK_PATTERN =
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/gu;

function replaceKnownSecrets(value: string, secrets: readonly string[]): string {
  const sortedSecrets = [...new Set(secrets)].sort((left, right) => right.length - left.length);
  let redacted = value;
  for (const secret of sortedSecrets) {
    if (secret.length === 0) {
      throw new TypeError("redaction対象の秘匿値に空文字は指定できません");
    }
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

/** 秘匿値を含み得る文字列をログ出力可能な文字列へ変換する。 */
export function redactSensitiveText(value: string, secrets: readonly string[]): string {
  return replaceKnownSecrets(value, secrets)
    .replace(PRIVATE_KEY_PATTERN, REDACTED)
    .replace(QUOTED_AUTHORIZATION_PATTERN, `$1"${REDACTED}"`)
    .replace(AUTHORIZATION_HEADER_PATTERN, `$1${REDACTED}`)
    .replace(GITHUB_TOKEN_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(DISCORD_WEBHOOK_PATTERN, REDACTED);
}

/** 実行中に増えるtokenを含めてredactionする。 */
export class SecretRedactor {
  readonly #secrets = new Set<string>();

  public constructor(initialSecrets: readonly string[]) {
    for (const secret of initialSecrets) {
      this.addSecret(secret);
    }
  }

  /** redaction対象の秘匿値を追加する。 */
  public addSecret(secret: string): void {
    if (secret.length === 0) {
      throw new TypeError("redaction対象の秘匿値に空文字は指定できません");
    }
    this.#secrets.add(secret);
  }

  /** 登録済み秘匿値を含む文字列を安全化する。 */
  public redact(value: string): string {
    return redactSensitiveText(value, [...this.#secrets]);
  }

  /** 捕捉した値から秘匿情報を含まないcauseを生成する。 */
  public createSafeCause(error: unknown): Error {
    if (error instanceof Error) {
      return new Error(this.redact(error.message));
    }
    if (typeof error === "string") {
      return new Error(this.redact(error));
    }
    return new Error("詳細を安全に取得できないエラーです");
  }
}
