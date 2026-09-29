import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

import { normalizedBundlePathSchema } from "../application/tracking-run/recovery-bootstrap.js";
import type { ContentDigestPort } from "../application/tracking-run/ports.js";
import { assertNonNullable } from "../util/assert-non-nullable.js";

const effectActionNames = [
  "actions/configure-pages",
  "actions/deploy-pages",
  "actions/upload-artifact",
  "actions/upload-pages-artifact",
];
const stepSchema = z.looseObject({ uses: z.string().optional() });
const workflowSchema = z.looseObject({
  jobs: z.record(
    z.string(),
    z.looseObject({
      uses: z.string().optional(),
      steps: z.array(stepSchema).optional(),
    }),
  ),
});
const actionSchema = z.looseObject({
  runs: z.looseObject({ steps: z.array(stepSchema).optional() }),
});

type ActionFile = Readonly<{
  path: string;
  byteLength: number;
  digest: ReturnType<ContentDigestPort["sha256Bytes"]>;
  bytes: Buffer;
}>;

function parseYaml(source: string): unknown {
  const document = parseDocument(source, {
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new TypeError("workflow actionのYAMLが不正です", { cause: document.errors[0] });
  }
  return document.toJS();
}

function workflowReferences(source: string): readonly string[] {
  const workflow = workflowSchema.parse(parseYaml(source));
  const references: string[] = [];
  for (const job of Object.values(workflow.jobs)) {
    if (job.uses != null && job.uses !== "./.github/workflows/_tracking-run.yml") {
      references.push(job.uses);
    }
    for (const step of job.steps ?? []) {
      if (step.uses != null) references.push(step.uses);
    }
  }
  return references;
}

function actionReferences(source: string): readonly string[] {
  const action = actionSchema.parse(parseYaml(source));
  return (action.runs.steps ?? []).flatMap((step) => (step.uses == null ? [] : [step.uses]));
}

async function checkedActionDirectory(
  repositoryPath: string,
  relativePath: string,
): Promise<string> {
  let directory = resolve(repositoryPath);
  for (const segment of relativePath.split("/")) {
    directory = join(directory, segment);
    const status = await lstat(directory);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new TypeError("workflowのlocal action pathは通常のdirectoryである必要があります");
    }
  }
  return directory;
}

async function actionFiles(
  repositoryPath: string,
  directory: string,
  digest: ContentDigestPort,
): Promise<readonly ActionFile[]> {
  const files: ActionFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TypeError("workflowのlocal action内のsymlinkは使用できません");
    }
    if (entry.isDirectory()) {
      files.push(...(await actionFiles(repositoryPath, path, digest)));
      continue;
    }
    if (!entry.isFile()) {
      throw new TypeError("workflowのlocal actionに通常file以外が含まれています");
    }
    const relativePath = relative(repositoryPath, path).split(sep).join("/");
    const bytes = await readFile(path);
    files.push({
      path: relativePath,
      byteLength: bytes.length,
      digest: digest.sha256Bytes(bytes),
      bytes,
    });
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** workflowのaction参照とlocal actionの実fileをadapter識別用に取得する。 */
export async function workflowActionSources(
  repositoryPath: string,
  workflowSources: readonly string[],
  digest: ContentDigestPort,
): Promise<
  Readonly<{
    effectActions: readonly (readonly [string, string])[];
    localActionFiles: readonly Readonly<{ path: string; byteLength: number; digest: string }>[];
  }>
> {
  const effectActions = new Map<string, string>();
  const localActions = new Map<string, readonly ActionFile[]>();
  const visiting = new Set<string>();

  async function visit(reference: string): Promise<void> {
    if (reference.startsWith("./")) {
      const relativePath = normalizedBundlePathSchema.parse(reference.slice(2));
      if (visiting.has(relativePath)) {
        throw new TypeError("workflowのlocal action参照が循環しています");
      }
      if (localActions.has(relativePath)) return;
      visiting.add(relativePath);
      const directory = await checkedActionDirectory(repositoryPath, relativePath);
      const files = await actionFiles(repositoryPath, directory, digest);
      const metadata = files.filter(
        (file) =>
          file.path === `${relativePath}/action.yml` || file.path === `${relativePath}/action.yaml`,
      );
      if (metadata.length !== 1) {
        throw new TypeError("workflowのlocal action定義は1つ必要です");
      }
      const definition = metadata[0];
      assertNonNullable(definition, "workflowのlocal action定義を取得できません");
      for (const nested of actionReferences(definition.bytes.toString("utf8"))) {
        await visit(nested);
      }
      visiting.delete(relativePath);
      localActions.set(relativePath, files);
      return;
    }
    const match = /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)@([0-9a-f]{40})$/u.exec(reference);
    if (match == null) {
      throw new TypeError("workflowの外部actionは完全なcommit SHAで固定してください");
    }
    const actionPath = match[1];
    const revision = match[2];
    assertNonNullable(actionPath, "workflowの外部action名を取得できません");
    assertNonNullable(revision, "workflowの外部action revisionを取得できません");
    const action = normalizedBundlePathSchema.parse(actionPath);
    if (effectActionNames.includes(action)) {
      const previous = effectActions.get(action);
      if (previous != null && previous !== revision) {
        throw new TypeError("workflow効果actionに異なるcommit SHAが混在しています");
      }
      effectActions.set(action, revision);
    }
  }

  for (const source of workflowSources) {
    for (const reference of workflowReferences(source)) {
      await visit(reference);
    }
  }
  if (effectActionNames.some((name) => !effectActions.has(name))) {
    throw new TypeError("workflowに必須の効果actionがありません");
  }
  return {
    effectActions: [...effectActions].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
    localActionFiles: [...localActions.values()]
      .flatMap((files) =>
        files.map(({ path, byteLength, digest: fileDigest }) => ({
          path,
          byteLength,
          digest: fileDigest,
        })),
      )
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  };
}
