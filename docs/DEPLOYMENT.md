# デプロイ手順

デプロイ先は`VOICEVOX/voicevox_task_tracker`のGitHub Actions、GitHub Pages、`tracker-state` branchです。
追跡対象のrepositoryへは読み取り専用GitHub Appで接続し、このrepositoryのstate更新とPages公開だけを`GITHUB_TOKEN`で行います。

## 現在の停止条件

現行の`.github/workflows/daily.yml`には、運用開始前に解消が必要な統合上の制約があります。

- `collect-analyze`が後続jobへ渡すartifactにはPages DTOだけがあり、`persist-state`と`notify-discord`が必要とする成果物を生成していません。
- `ai.enabled`を有効にした場合に必要な`codex` executableをworkflowがインストールしていません。
- `tracker:run`は収集job内でもstate、Pages、Discordのstageを実行するため、workflowのjob分離と副作用境界が一致していません。
- state commit後にPagesかDiscordが失敗してもstateを戻さないため、外部公開までを一つのtransactionとして扱えません。

この状態ではローカルdry-runまで確認できますが、Actionsによるstate永続化、Pages deploy、Discord通知を正常系として開始できません。
停止条件を解消するまではActions画面からworkflowを無効にし、`notifications.discord.enabled`と`ai.enabled`を`false`にしてください。
本タスクは文書整備だけを対象とするため、workflowと実行コードは変更していません。

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
installation IDは実行時にOrganizationから自動発見するため、現行workflowでは設定しません。

## Actionsの設定

repositoryのSettingsからActions variableとActions secretを登録します。

| 名前                  | 種別     | 必要になる条件                        | 値                                    |
| --------------------- | -------- | ------------------------------------- | ------------------------------------- |
| `GH_APP_ID`           | Variable | 常時                                  | GitHub Appの数値ID                    |
| `GH_APP_PRIVATE_KEY`  | Secret   | 常時                                  | GitHub Appから発行したPEM private key |
| `OPENAI_API_KEY`      | Secret   | `ai.enabled: true`                    | Codexの非対話実行に使うAPI key        |
| `DISCORD_WEBHOOK_URL` | Secret   | `notifications.discord.enabled: true` | 公開channelのIncoming Webhook URL     |

PEM private keyは改行を保持したままsecretへ登録します。
認証情報を`config.yml`、branch、artifact、run logへ書きません。

ActionsのWorkflow permissionsは、`persist-state` jobが`tracker-state`へpushできるようにread and writeを許可します。
workflow側では各jobが必要な権限だけを再指定しています。
`tracker-state`へrulesetを設定する場合はGitHub Actionsによるstate更新を許可し、人間の通常作業branchとして使わないでください。

## Pagesの設定

repositoryをpublicにした後、SettingsのPagesでSourceを`GitHub Actions`にします。
branchをPages sourceへ指定しません。

現行構成では`config.yml`の`web.basePath`を`/voicevox_task_tracker/`にし、公開URLを`https://voicevox.github.io/voicevox_task_tracker/`とします。
workflowの`deploy-pages` jobは`github-pages` environmentへdeployし、`pages: write`と`id-token: write`だけを使用します。

## config.yml

初回runより前に`YOUR_`で始まるplaceholderを解消します。
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
| `ai.model`                                          | workflowのCodex CLIで利用できる固定model ID                   |
| `ai.confidence`                                     | highとmediumの境界                                            |
| `ai.budget`                                         | call数、入力文字数、推定費用のrun上限                         |
| `notifications.discord.enabled`                     | Discord通知を送るかどうか                                     |
| `notifications.discord.webhookSecretName`           | 通常通知用secretの環境変数名                                  |
| `notifications.discord.operationsWebhookSecretName` | 障害通知用secretの環境変数名                                  |
| `notifications.discord.mentions`                    | mentionの有効化とGitHub loginからDiscord user IDへのallowlist |
| `notifications.discord.maxItemsPerDigest`           | 1回のdigestへ含める最大項目数                                 |
| `notifications.discord.cooldownDays`                | urgentとcriticalの再通知間隔                                  |
| `notifications.discord.silenceWhenEmpty`            | 候補0件の通常digestを送らない設定                             |
| `state`                                             | 固定branch、snapshot、履歴、cache、ledger、reportの保存先     |
| `web`                                               | base path、画面名、locale、初期graph上限                      |
| `operations.githubApiBudgetRatio`                   | 1 runで使ってよいGitHub API予算の比率                         |
| `operations.retry`                                  | GitHubとDiscordの一時失敗に対するretry設定                    |

初期導入では次の値にします。

```yaml
ai:
  enabled: false

notifications:
  discord:
    enabled: false
    mentions:
      enabled: false
      users: {}

operations:
  failOnPrivateDataGuard: true
  publishPartialData: false
```

`ai`と`notifications.discord`の残りの必須fieldは削除せず、既存の形を保ちます。
現行workflowが公開するDiscord secretは`DISCORD_WEBHOOK_URL`だけなので、`webhookSecretName`と`operationsWebhookSecretName`はどちらもこの名前にします。

## 段階的な導入

### 1. ローカルdry-run

実在するteam slugを設定し、GitHub Appの環境変数を安全な方法でshellへ渡します。
`ai.enabled`と`notifications.discord.enabled`は`false`のままにします。

依存関係を検証してCLIをビルドします。

```console
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

公開副作用を起こさない`dry-run`を実行します。

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

固定versionのCodex CLIが`codex`として`PATH`にあり、実装が使う`codex exec` optionへ対応することを確認します。
`OPENAI_API_KEY`をsecretとして渡し、`ai.model`のplaceholderを利用可能なmodel IDへ置き換えてから`ai.enabled`を`true`にします。

同じdry-runを実行し、`aiCallCount`、`aiCacheHitCount`、`estimatedInputTokens`、`diagnostics`を確認します。
model、prompt、schemaを変更した場合は`pnpm eval:golden`も実行します。
ActionsでCodexを有効化するのは、停止条件に記載したCLI導入をworkflowへ実装した後です。

### 3. stateとPages

停止条件を解消した後、PagesのSourceを`GitHub Actions`にして日次workflowを手動実行します。
入力は`backfill: none`とし、repository filterは空にします。
`notifications.discord.enabled`は`false`のままにします。

成功後に次を確認します。

- `tracker-state`がmainと別の履歴を持つこと
- snapshot、当日履歴、通知ledger、run reportが同じstate commitにあること
- Pagesの生成時刻、repository数、item数、stale表示がrun reportと一致すること
- private repositoryのID、名前、URL、secret、不要な本文がstateとPagesにないこと

`tracking.startAt: null`なら、最初の完全成功runの時刻がsnapshotへ固定されます。
Pagesとdry-runの判定を少なくとも2週間確認し、必要なteam、label、閾値を調整します。

### 4. Discord

公開channel用のIncoming Webhookを作成し、`DISCORD_WEBHOOK_URL`へ登録します。
最初は`mentions.enabled: false`のまま`notifications.discord.enabled: true`へ変更します。

手動runでPages deploy後にだけ通知されること、候補0件なら送信されないこと、再実行でcooldownが効くことを確認します。
確認後にscheduleを運用へ移します。
GitHub Actionsのscheduleは遅延し得るため、08:00 JSTは起動予定時刻として扱います。

mentionが必要になった場合だけ、GitHub loginと17桁から20桁のDiscord user IDを`mentions.users`へ登録します。
登録されていないuserと`@everyone`はmentionされません。
