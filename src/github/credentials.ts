import { z } from "zod";

import { GitHubCredentialsError } from "./errors.js";

const positiveSafeIntegerTextSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .refine(Number.isSafeInteger);

const privateKeySchema = z
  .string()
  .min(1)
  .regex(
    /^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+-----END (?:RSA |EC )?PRIVATE KEY-----\s*$/,
  );

const credentialsSchema = z.strictObject({
  GH_APP_ID: positiveSafeIntegerTextSchema,
  GH_APP_PRIVATE_KEY: privateKeySchema,
  GH_APP_INSTALLATION_ID: positiveSafeIntegerTextSchema.optional(),
});

export type GitHubAppCredentials = Readonly<{
  appId: number;
  privateKey: string;
  installationId?: number;
}>;

function formatCredentialPath(path: readonly PropertyKey[]): string {
  const firstSegment = path.at(0);
  if (typeof firstSegment !== "string") {
    return "GitHub App認証情報";
  }
  return firstSegment;
}

/** 指定された環境変数からGitHub App認証情報だけを読み取る。 */
export function parseGitHubAppCredentials(
  environment: Readonly<NodeJS.ProcessEnv>,
): GitHubAppCredentials {
  const result = credentialsSchema.safeParse({
    GH_APP_ID: environment["GH_APP_ID"],
    GH_APP_PRIVATE_KEY: environment["GH_APP_PRIVATE_KEY"],
    GH_APP_INSTALLATION_ID: environment["GH_APP_INSTALLATION_ID"],
  });
  if (!result.success) {
    const variableNames = [
      ...new Set(result.error.issues.map((issue) => formatCredentialPath(issue.path))),
    ];
    throw new GitHubCredentialsError(variableNames);
  }

  const credentials = {
    appId: result.data.GH_APP_ID,
    privateKey: result.data.GH_APP_PRIVATE_KEY,
    ...(result.data.GH_APP_INSTALLATION_ID == null
      ? {}
      : { installationId: result.data.GH_APP_INSTALLATION_ID }),
  } satisfies GitHubAppCredentials;
  return credentials;
}

/** process.envからGitHub App認証情報だけを読み取る。 */
export function readGitHubAppCredentials(): GitHubAppCredentials {
  return parseGitHubAppCredentials(process.env);
}
