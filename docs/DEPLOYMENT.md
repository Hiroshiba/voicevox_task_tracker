# デプロイ手順

デプロイ先は`VOICEVOX/voicevox_task_tracker`のGitHub Actions、GitHub Pages、`tracker-state` branchです。
追跡対象のrepositoryへは読み取り専用GitHub Appで接続します。
このrepositoryのstate更新とPages公開には、GitHub Actionsがjobごとに自動発行する`GITHUB_TOKEN`を使います。

## GitHub App

VOICEVOX Organizationの設定からGitHub Appを作成します。

1. Organization SettingsのDeveloper settingsからGitHub Appsを開きます。
2. New GitHub Appを選び、Organization内で識別できるApp名とrepositoryのURLを設定します。
3. Webhookを無効にし、event購読を追加しません。
4. 下表のread権限だけを設定してAppを作成します。
5. private keyを発行し、VOICEVOX Organizationへinstallします。

repositoryへのアクセス範囲は次のどちらかを選びます。

- `All repositories`は新しい公開repositoryを設定変更なしで発見できますが、private repositoryへ技術的にアクセスできるため三重guardを前提とします。
- `Selected repositories`は公開repositoryだけを選べますが、新しいrepositoryを作るたびにinstallation設定の更新が必要です。

動的発見を使う既定構成は`All repositories`です。
どちらを選んでも、Appへwrite権限を与えません。

### Repository permissions

| Permission      | Access    | 用途                                                   |
| --------------- | --------- | ------------------------------------------------------ |
| Metadata        | Read-only | visibility、archive、disabled、ID、名前のinventory     |
| Issues          | Read-only | Issue、comment、timeline、native dependency、sub-issue |
| Pull requests   | Read-only | PR、review、review request、review thread、head情報    |
| Checks          | Read-only | check runの状態                                        |
| Commit statuses | Read-only | commit status context                                  |

### Organization permissions

| Permission | Access    | 用途                                    |
| ---------- | --------- | --------------------------------------- |
| Members    | Read-only | 設定したteam slugの存在確認とmember解決 |

`Contents`、`Actions`、`Administration`、`Projects`など、表にない権限は`No access`のままにします。
installation IDは実行時にOrganizationから自動発見します。
ローカル実行では任意の環境変数`GH_APP_INSTALLATION_ID`でinstallation IDを上書きでき、指定した場合は自動発見を省略します。
workflowでは`GH_APP_INSTALLATION_ID`を設定しません。

## Actionsの設定

repositoryのSettingsからActions variableとActions secretを登録します。

| 名前                             | 種別     | 値                                    |
| -------------------------------- | -------- | ------------------------------------- |
| `GH_APP_ID`                      | Variable | GitHub Appの数値ID                    |
| `GH_APP_PRIVATE_KEY`             | Secret   | GitHub Appから発行したPEM private key |
| `OPENAI_API_KEY`                 | Secret   | Codexの非対話実行に使うAPI key        |
| `DISCORD_WEBHOOK_URL`            | Secret   | 通常digest用のIncoming Webhook URL    |
| `DISCORD_OPERATIONS_WEBHOOK_URL` | Secret   | 運用障害通知用のIncoming Webhook URL  |

PEM private keyは改行を保持したままsecretへ登録します。
現行の`config.yml`は`ai.authentication: api-key`を指定し、`collect-analyze` jobは`OPENAI_API_KEY`だけをCodexへ渡します。
`ai.authentication: auth-json`はCodexの`auth.json`で認証する方式で、含まれるtokenが更新されるためActionsでは使いません。
認証情報を`config.yml`、branch、artifact、run logへ書きません。

repositoryのWorkflow permissionsは既定の読み取り専用にします。
read and writeへ変更する必要はありません。
全workflowはtop-levelの`permissions`を空にし、各jobで必要な権限だけを指定しています。
`persist-state`、`notify-discord`、`notify-operations`は`tracker-state`へpushするため、それぞれ`contents: write`を指定します。
これらのjobにはGitHub Actionsが`GITHUB_TOKEN`を自動発行するため、独自の`GITHUB_TOKEN` secretは登録しません。

CLIはremote repositoryへpushしません。
`src/persistence/git-state-branch-adapter.ts`が`hash-object`、`commit-tree`、`update-ref`などを使い、localの`refs/heads/tracker-state`へcommitを作ります。
workflowはCLIの実行前にremoteの`tracker-state`をlocal refへfetchし、CLIの実行後に明示的な`git push`でremoteへ反映します。
`tracker-state`へrulesetを設定する場合はGitHub Actionsによるstate更新を許可し、人間の通常作業branchとして使わないでください。

`collect-analyze`は`artifacts/workflow/validated-run.json`へ検証済みsnapshot、通知候補、notification ledger、run report、AI cache、Pages URL、Discord送信設定だけを書きます。
GitHub App key、installation token、OpenAI認証情報、Discord webhookはartifactへ含めません。
artifactを利用する後続jobは同じartifactを再検証してから利用します。
依存関係を再インストールせず`notify-discord`でCLIを動かすため、公開sourceから作った自己完結bundleも同じActions artifactへ保存します。

## Pagesの設定

repositoryをpublicにした後、SettingsのPagesでSourceを`GitHub Actions`にします。
branchをPages sourceへ指定しません。

現行構成では`config.yml`の`web.basePath`を`/voicevox_task_tracker/`にし、公開URLを`https://voicevox.github.io/voicevox_task_tracker/`とします。
workflowの`deploy-pages` jobはrepositoryをcheckoutせず、`build-pages`が保存したPages artifactを`github-pages` environmentへdeployするだけです。
このため`pages: write`と`id-token: write`だけを使用します。

## config.yml

現行の`config.yml`には実運用値が入っています。
初回runより前に、設定済みのorganization、team slug、model ID、公開URL、secret名がデプロイ先と一致することを確認します。
Zodのstrict schemaで未知のfieldも拒否するため、設定名は`config.yml`にあるものだけを使います。

| 設定                                                | 指定内容                                                      |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `schemaVersion`                                     | 対応majorである`1`                                            |
| `organization`                                      | 固定値`VOICEVOX`                                              |
| `tracking.startAt`                                  | 追跡開始日時か`null`                                          |
| `tracking.autoInclude`                              | 作成日時、活動、参照、native relationによる自動追加規則       |
| `tracking.include`                                  | 常に追跡するIssueかPRのHTTPS URL、またはGitHub node ID        |
| `tracking.retentionDaysAfterTerminal`               | terminal項目を保持する日数                                    |
| `tracking.backfill.maxItemsPerRun`                  | 1回のbackfillで追加する上限                                   |
| `teams.defaults`                                    | 既定のmaintainer teamとreviewer teamの実在slug                |
| `teams.repositories`                                | `VOICEVOX/repository`ごとのteam上書き                         |
| `actors.bots`                                       | botのlogin pattern、既知login、人間扱いする例外               |
| `labels.rules`                                      | repository glob、label名の正規表現、判定と通知への効果        |
| `staleness`                                         | 進捗猶予時間とwait class別のwatch、urgent、critical閾値       |
| `ai.enabled`                                        | Codexを呼び出すかどうか                                       |
| `ai.authentication`                                 | workflowでは`api-key`、ローカル実行では`api-key`か`auth-json` |
| `ai.model`                                          | 固定したCodex CLIと認証情報で利用できる設定済みmodel ID       |
| `ai.confidence`                                     | highとmediumの境界                                            |
| `ai.budget`                                         | call数、入力文字数、推定費用のrun上限                         |
| `notifications.discord.enabled`                     | Discord通知を送るかどうか                                     |
| `notifications.discord.webhookSecretName`           | 通常通知用secretの環境変数名                                  |
| `notifications.discord.operationsWebhookSecretName` | 障害通知用secretの環境変数名                                  |
| `notifications.discord.mentions`                    | mentionの有効化とGitHub loginからDiscord user IDへのallowlist |
| `notifications.discord.maxItemsPerDigest`           | 1回のdigestへ含める最大項目数                                 |
| `notifications.discord.cooldownDays`                | urgentとcriticalの再通知間隔                                  |
| `state`                                             | 固定branch、snapshot、履歴、cache、ledger、reportの保存先     |
| `web`                                               | base path、画面名、locale、初期graph上限                      |
| `operations.githubApiBudgetRatio`                   | 1 runで使ってよいGitHub API予算の比率                         |
| `operations.retry`                                  | GitHubとDiscordの一時失敗に対するretry設定                    |

現行設定ではCodexとDiscord通知が有効です。
`ai.model`の利用可否は、lockfileで固定したCodex CLIと`OPENAI_API_KEY`を使うdry-runで確認します。
`webhookSecretName`には`DISCORD_WEBHOOK_URL`、`operationsWebhookSecretName`には`DISCORD_OPERATIONS_WEBHOOK_URL`を指定します。
通常digestと運用障害通知を同じchannelへ送る場合は、2つのsecretへ同じIncoming Webhook URLを登録します。

## 段階的な導入

### 1. ローカルdry-run

`.node-version`に記載されたNode.jsをversion managerで有効にします。
Node.jsのversionを確認した後にCorepackを有効にし、`package.json`で固定されたpnpmを使います。

```console
node --version
corepack enable
pnpm --version
```

設定済みのteam slugがOrganizationに存在することを確認します。
GitHub Appの`GH_APP_ID`と`GH_APP_PRIVATE_KEY`、Codexの`OPENAI_API_KEY`を安全な方法でshellへ渡します。
`dry-run`はDiscord webhookを読み取らず、state、Pages、Discordを変更しません。

依存関係を検証してCLIをビルドします。

```console
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

現在の`config.yml`を変更せずに`dry-run`を実行します。

```console
node --input-type=module --eval '
const { createDefaultCliApplication } = await import("./dist/index.js");
const result = await createDefaultCliApplication().run([
  "dry-run",
  "--config",
  "config.yml",
  "--artifact",
  "artifacts/dry-run.json",
  "--report",
  "artifacts/run-reports/dry-run.json",
]);
process.exitCode = result.exitCode;
'
```

`artifacts/run-reports/dry-run.json`の`status`、`complete`、`diagnostics`、各metricを確認します。
`artifacts/dry-run.json`には検証済みsnapshotと通知候補が入るため、repository範囲、waitingOn、関係、通知量を確認します。

### 2. Codexのdry-run

lockfileで固定したCodex CLI `0.145.0`を確認します。

```console
pnpm exec codex --version
```

現行の`config.yml`は`ai.enabled: true`と`ai.authentication: api-key`を設定済みです。
ローカルでAPI keyを使わずCodexの`auth.json`で認証する場合は、`ai.authentication`を`auth-json`にし、`auth.json`を直下に置いたdirectoryを`CODEX_HOME`へ指定します。
どちらの方式でも、選択しなかった方式の環境変数はCodexへ渡りません。

`OPENAI_API_KEY`を渡して同じ`dry-run`を実行し、`ai.model`に設定されたmodel IDでCodex呼び出しが成功することを確認します。
`aiCallCount`が1以上で`status`が`success`となり、`diagnostics`にmodelの利用不可を示す内容がなければ、設定済みmodel IDを利用できています。
`aiCallCount`が0ならmodelを呼び出していないため、利用可否を確認できていません。
その場合は設定済みmodel IDを`--model`へ指定した最小の`pnpm exec codex exec`を同じ認証情報で実行します。

`aiCacheHitCount`、`estimatedInputTokens`、`diagnostics`も確認します。
model、prompt、schemaを変更した場合は`pnpm eval:golden`も実行します。
Actionsの`collect-analyze` jobはlockfileから同じCodex CLIをインストールし、収集前にversion確認を行います。

### 3. stateとPages

PagesのSourceを`GitHub Actions`にして、repositoryのdefault branchから日次workflowを手動実行します。
workflowはdefault branchからのscheduleまたは手動実行だけを許可します。
入力は`backfill: none`とし、repository filterは空にします。

成功後に次を確認します。

- `tracker-state`がdefault branchと別の履歴を持つこと
- `persist-state`のcommitにsnapshot、当日履歴、新しいAI cache、通知ledger、run reportがまとまっていること
- 通知を送った場合は後続の通知jobが通知ledgerだけのcommitを追加していること
- Pagesの生成時刻、repository数、item数、stale表示がrun reportと一致すること
- private repositoryのID、名前、URL、secret、不要な本文がstateとPagesにないこと

`tracking.startAt: null`なら、最初の完全成功runの時刻がsnapshotへ固定されます。
Pagesとdry-runの判定を少なくとも2週間確認し、必要なteam、label、閾値を調整します。

### 4. Discord

通常digest用のIncoming Webhookを作成し、`DISCORD_WEBHOOK_URL`へ登録します。
運用障害通知用のIncoming Webhookを作成し、`DISCORD_OPERATIONS_WEBHOOK_URL`へ登録します。
現行設定は`notifications.discord.enabled: true`と`mentions.enabled: false`です。

手動runで通常digestがPages deploy後にだけ通知されること、候補0件なら送信されないこと、再実行でcooldownが効くことを確認します。
収集またはPagesの処理が失敗した場合は、運用障害通知が送られることも確認します。
GitHub Actionsのscheduleは遅延し得るため、08:00 JSTは起動予定時刻として扱います。

mentionが必要になった場合だけ、GitHub loginと17桁から20桁のDiscord user IDを`mentions.users`へ登録します。
登録されていないuserと`@everyone`はmentionされません。
