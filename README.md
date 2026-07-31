# VOICEVOX Task Tracker

VOICEVOX Organizationの公開IssueとPull Requestを横断して、現在の状態、次に行動する主体、停滞時間、依存関係を整理するプロジェクトです。
毎日08:00 JSTにGitHub Actionsから実行し、GitHub Pagesへ一覧と依存グラフを公開して、対応が必要な変化だけをDiscordへ通知します。
追跡対象のIssue、Pull Request、コメント、ラベル、アサイン、レビュー依頼は変更しません。

## 主要な仕組み

- GitHubのレビュー依頼、アサイン、native dependencyなどの確定情報を決定論的な規則で先に評価します。
- Codexは未回答の依頼やリンクの意味など、自然言語の解釈が必要な変更だけを分析します。
- 公開かつ非アーカイブで、無効化されていないリポジトリだけを扱います。
- 公開対象外のデータやsecretを検出したrunはfail closedとし、state、Pages、Discordを更新しません。
- snapshot、日次履歴、AI cache、通知ledger、run reportは専用の`tracker-state` branchへ保存します。

## 開発環境

- Node.js 24.11.1
- pnpm 10.33.4

依存関係をインストールします。

```console
pnpm install --frozen-lockfile
```

## 開発コマンド

| コマンド            | 内容                                              |
| ------------------- | ------------------------------------------------- |
| `pnpm build`        | CLIを`dist`へビルドする                           |
| `pnpm build:web`    | 静的サイトを`dist/web`へビルドする                |
| `pnpm dev:web`      | サンプル公開DTOを使ってWeb UIを起動する           |
| `pnpm eval:golden`  | CLIをビルドしてgolden fixtureの回帰評価を実行する |
| `pnpm perf:profile` | モックの日次runでOPS-004の性能閾値を検証する      |
| `pnpm typecheck`    | CLIとWeb UIの型を検査する                         |
| `pnpm test`         | Vitestのテストを1回実行する                       |
| `pnpm lint`         | ESLintでコードを検査する                          |
| `pnpm format`       | Prettierで対象ファイルを整形する                  |
| `pnpm format:check` | Prettierによる整形差分がないことを検査する        |

`pnpm tracker:run --backfill none`はビルド済みCLIを使う通常の運用コマンドです。
必要な認証情報と使い方は[運用手順](docs/OPERATIONS.md)を参照してください。

## ディレクトリ構成

| パス                 | 内容                                                               |
| -------------------- | ------------------------------------------------------------------ |
| `.github/workflows/` | CIと日次runのGitHub Actions workflow                               |
| `src/cli/`           | コマンド解析、日次トランザクション、実アダプターの合成             |
| `src/config/`        | `config.yml`の読み込みと検証                                       |
| `src/github/`        | GitHub App認証、読み取り専用API、収集、正規化、公開allowlist       |
| `src/domain/`        | 状態機械、追跡選定、停滞時間、severityのpure TypeScript            |
| `src/graph/`         | 関係候補、edge reconcile、cycle、frontier、影響度のpure TypeScript |
| `src/codex/`         | Codexの隔離実行、cache、予算、出力検証                             |
| `src/persistence/`   | canonical state、履歴、ledger、state branch操作                    |
| `src/pages/`         | 公開guardとPages用DTO生成                                          |
| `src/discord/`       | 通知選別、payload生成、Webhook送信                                 |
| `src/eval/`          | golden fixtureの回帰評価                                           |
| `src/performance/`   | 日次run全体の性能と予算のprofile                                   |
| `web/`               | ViteとPreactによる静的Web UI                                       |
| `tests/`             | unit、integration、security、golden fixtureのテスト                |
| `schemas/`           | stateとCodex出力のJSON Schema                                      |
| `prompts/`           | Codexへ渡す固定system prompt                                       |
| `docs/`              | 設計、デプロイ、運用、実装計画                                     |

## 詳細文書

- [アーキテクチャ](docs/ARCHITECTURE.md)
- [デプロイ手順](docs/DEPLOYMENT.md)
- [運用手順](docs/OPERATIONS.md)
- [実装計画](docs/IMPLEMENTATION_PLAN.md)
