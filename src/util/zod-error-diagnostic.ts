import { z } from "zod";

const ZOD_ISSUE_LIMIT = 10;
const zodIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
  expected: z.string().optional(),
});

export type ZodValidationIssue = Readonly<{
  path: readonly (string | number)[];
  code: string;
  expected?: string;
}>;

export type ZodErrorDiagnostics = Readonly<{
  issueCount: number;
  issues: readonly ZodValidationIssue[];
  omittedIssueCount: number;
}>;

/** ZodErrorから安全なschema診断情報だけを取り出す。 */
export function createZodErrorDiagnostics(error: z.ZodError): ZodErrorDiagnostics {
  const issues: ZodValidationIssue[] = [];
  for (const issue of error.issues.slice(0, ZOD_ISSUE_LIMIT)) {
    const result = zodIssueSchema.safeParse(issue);
    if (!result.success) {
      continue;
    }
    if (result.data.expected == null) {
      issues.push(
        Object.freeze({
          path: Object.freeze([...result.data.path]),
          code: result.data.code,
        }),
      );
      continue;
    }
    issues.push(
      Object.freeze({
        path: Object.freeze([...result.data.path]),
        code: result.data.code,
        expected: result.data.expected,
      }),
    );
  }
  const frozenIssues = Object.freeze(issues);
  return Object.freeze({
    issueCount: error.issues.length,
    issues: frozenIssues,
    omittedIssueCount: error.issues.length - frozenIssues.length,
  });
}
