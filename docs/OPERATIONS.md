# 運用手順

正常運用時のVOICEVOX Task Trackerは毎日23:00 UTCに起動し、日本時間の08:00以降にPagesとDiscordを更新します。
GitHub Actionsのscheduleには遅延があるため、厳密な投稿時刻は保証しません。
現在のActions統合にある停止条件は[デプロイ手順](DEPLOYMENT.md)を参照してください。

## 日々の確認

`.github/workflows/daily.yml`の最新runで、各jobが順に成功したことを確認します。

1. `test-eval`
2. `collect-analyze`
3. `persist-state`
4. `build-pages`
5. `deploy-pages`
6. `notify-discord`

Pagesでは生成時刻、repository数、item数、unknown数、状態別件数、severity別件数を確認します。
`tracker-state`では`state/run-reports/YYYY-MM-DD.json`を確認します。
ローカル実行のreportは`artifacts/run-reports/`へ出力されます。

run reportの主な確認項目は次のとおりです。

| field                  | 意味                                                                          |
| ---------------------- | ----------------------------------------------------------------------------- |
| `status`               | `success`は完全成功、`fallback`はCodex縮退を含む完全run、`failure`は不完全run |
| `complete`             | stateと公開処理へ進める完全性を満たしたか                                     |
| `failedStage`          | failureが起きた処理段階                                                       |
| `diagnostics`          | secretや信頼できない本文を含まない診断                                        |
| `repositoryCount`      | 公開allowlistに入ったrepository数                                             |
| `itemCount`            | 追跡項目数                                                                    |
| `changedItemCount`     | 前回から更新された追跡項目数                                                  |
| `activeEdgeCount`      | 有効な関係edge数                                                              |
| `aiCallCount`          | Codexを実行した件数                                                           |
| `aiCacheHitCount`      | AI cacheを再利用した件数                                                      |
| `estimatedInputTokens` | Codex入力tokenの見積り                                                        |
| `githubApiRemaining`   | 最後に観測したGitHub API残量                                                  |
| `notificationCount`    | 送信結果をledgerへ記録した通知数                                              |

`tracker-state`は自動更新専用です。
人間がsnapshot、履歴、AI cache、通知ledgerを直接編集すると履歴とcooldownの整合を壊すため、修正はGitHub上の正本か`config.yml`で行います。

## 誤判定の直し方

tracker専用のcommand comment、override UI、専用labelはありません。
次回runで機械的に解釈できるように、GitHub上の事実を明確にします。

### コメント

最新コメントで、次に誰が何をするかを一文で明示します。
判断依頼なら対象のuserかteam、必要な判断、回答済みかどうかを具体的に書きます。
依存関係なら対象IssueかPRのURLと、現在の項目を止めているか、単なる関連情報かを明記します。

古いmention、謝辞、単なるリンクだけでは責務移動やblockerを確定しません。
依頼が解決した場合は、回答か決定を新しいコメントとして残すと未回答扱いを解消しやすくなります。

### ラベル

`config.yml`の`labels.rules`へ登録した既存labelだけがtrackerの意味を持ちます。
repository globとlabel名の正規表現を一致させ、必要な効果を設定します。

| effect                       | 用途                                      |
| ---------------------------- | ----------------------------------------- |
| `priorityWeight`             | attention queueと通知候補の並び順を上げる |
| `severityLift`               | severityを最大1段階引き上げる             |
| `requiresMaintainerDecision` | maintainerの判断待ちとして扱う            |
| `suppressNotifications`      | graphには残したまま通常通知を抑える       |
| `countsAsProgress`           | そのlabel変更を意味のある進捗として扱う   |

trackerはlabelを追加も変更もしません。
label規則を変えた場合は`pnpm test`と`pnpm eval:golden`で通知差分を確認します。

### review request

PRのCurrent reviewersへ実際に待っているuserかteamを追加します。
不要になったreview requestはGitHub上で解除します。
現在のreview requestは自然言語より強い決定論的根拠です。

人間の`CHANGES_REQUESTED`が最新head以後にある場合はauthor待ちが優先されます。
authorが修正をpushした後はreviewer側を再評価するため、必要ならreview requestも現在の担当へ合わせます。
botのreviewとcommentだけではbotへ責務を移しません。

### native dependency

本当に作業を止めるIssue同士はGitHubのblocked byとblockingで接続します。
親子関係はsub-issueを使います。
native relationはauthoritativeであり、本文のplain linkやCodex推定より優先されます。

blockerが完了したら対象Issueをcloseし、誤ったnative relationはGitHub上で解除します。
単なる関連項目はnative dependencyにせず、本文かコメントで関連だけであることを明記します。

修正を反映したい場合は日次runを待つか、日次workflowを`backfill: none`で手動実行します。

## backfill

backfillはGitHub Actionsの`日次タスク追跡`を手動実行して指定します。

| `backfill` | 対象                                                     |
| ---------- | -------------------------------------------------------- |
| `none`     | 通常の日次追跡だけを行う                                 |
| `linked`   | 追跡済み項目とrelationで接続する未追跡open項目を追加する |
| `all-open` | 対象repositoryの全open IssueとPull Requestを追加する     |

`repository_filter`は`VOICEVOX/voicevox,VOICEVOX/voicevox_engine`のようなfull nameのカンマ区切りです。
空ならVOICEVOX全体が対象です。
`backfill: none`ではrepository filterを指定できません。

1 runで追加する件数は`tracking.backfill.maxItemsPerRun`までです。
上限を超える場合は同じmodeとfilterで手動runを繰り返します。
`linked`は追跡済み項目の直接の隣接項目を追加し、繰り返すと新しく追加した項目の隣接へ範囲を広げます。

特定の古いIssueかPRだけを追加する場合は、URLかnode IDを`tracking.include`へ追加します。
一度追跡対象へ入った項目は作成日時に関係なく同じ状態、停滞、通知規則で扱います。
大規模な`all-open`はCodex予算と通知候補を急増させるため、Discordを無効にしてrepository単位で確認してから範囲を広げます。

## 通知量の調整

通知選別はseverityの変化、長期停滞、責務移動、重要な依存解消、dependency cycleを優先します。
直近に意味のある進捗がある項目、botだけの活動、recent draft、低信頼のAI判定、labelで抑制した項目は通常通知から外します。

通知が多すぎる場合は次の順で調整します。

1. 誤った責務や依存をGitHub上で明確にします。
2. automation dashboardなどへ`labels.rules.effects.suppressNotifications`を割り当てます。
3. `staleness.thresholdsHours`と`recentProgressGraceHours`を増やします。
4. `cooldownDays`を増やし、`maxItemsPerDigest`を減らします。
5. AI推定が原因なら`ai.confidence.medium`を上げ、golden evalでrecallを確認します。

通知が少なすぎる場合は逆方向に調整します。

1. team、review request、native dependency、label規則が実態と一致するか確認します。
2. `staleness.thresholdsHours`と`recentProgressGraceHours`を減らします。
3. `maxItemsPerDigest`を増やし、`cooldownDays`を減らします。
4. 重要labelへ`priorityWeight`か`severityLift: 1`を設定します。
5. AI予算不足なら`ai.budget`を増やし、費用とgolden evalを確認します。

閾値、confidence、label規則、model、promptを変更する場合は、`pnpm test`と`pnpm eval:golden`を通してから反映します。
mentionは通知量の調整に使わず、運用上必要なuserだけをallowlistへ追加します。

## 障害時の確認

失敗したActions jobとrun reportの`failedStage`を対応させて確認します。

| stageまたはjob                  | 確認内容                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `test-eval`                     | `pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm eval:golden`をローカルで再現する |
| `configuration`                 | placeholder、team slug、未知field、日時、正規表現、secret名を確認する                                   |
| `authentication`                | `GH_APP_ID`、PEM形式、Organizationへのinstallation、必要なread権限だけがあることを確認する              |
| `repository_inventory`          | Appのrepository access、team access、public、archive、disabledの状態を確認する                          |
| `incremental_collection`        | GitHub API残量、429と503、対象repositoryの一時障害を確認する                                            |
| `codex_analysis`                | `codex` executable、model ID、`OPENAI_API_KEY`、予算、timeoutを確認する                                 |
| `state_persistence`             | Actionsの`contents: write`、`tracker-state`のruleset、同時runがないことを確認する                       |
| `build-pages`                   | Pages DTO、`web.basePath`、Web build、公開guardの診断を確認する                                         |
| `deploy-pages`                  | Pages Source、`github-pages` environment、`pages: write`と`id-token: write`を確認する                   |
| `discord`または`notify-discord` | enabled設定、Webhook secret、channel、Webhook失効、429と503を確認する                                   |

`fallback`はCodexを利用できなかった項目を決定論的判定へ縮退した完全runです。
PagesでAI unavailableと不確実性を確認し、原因を直して再実行します。
`failure`が`state_persistence`より前ならstateは更新されません。
`pages`か`discord`で失敗した場合はstate commit後の可能性があるため、snapshotのrun IDとPagesの生成時刻を比較し、両者が同じrunか確認します。
Pages deployに失敗した場合は最後に成功したPagesを基準にし、Discordを送信しません。

公開guardが失敗した場合は安全設定を無効化しません。
どの入力にallowlist外repository、private sentinel、secretらしい値、長すぎる全文、安全でないURLが入ったかを、secretをlogへ出さずに調べます。
原因を除いた後に`backfill: none`で手動再実行します。

同じrunを再実行してもworkflow concurrencyと通知ledgerが競合と通常通知の重複を抑えます。
GitHub、Codex、Discordの429と503は設定した回数だけretryし、それでも失敗する場合は外部サービスの回復後に再実行します。
