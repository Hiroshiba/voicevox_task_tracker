# VOICEVOX Task Tracker

VOICEVOX Organizationの公開かつ非アーカイブのリポジトリを対象に、IssueとPull Requestの状態、次に行動すべき主体、停滞時間、依存関係を整理するプロジェクトです。

GitHubの確定情報を優先して状態を決定し、自然言語の解釈が必要な曖昧部分だけをCodexで補助します。リポジトリを横断する依存関係をグラフ化し、GitHub Pagesでの可視化とDiscordへの要点通知を行います。追跡状態は専用のGitブランチに保存します。

## 開発環境

- Node.js 24.11.1
- pnpm 10.33.4

依存関係は次のコマンドでインストールします。

```console
pnpm install
```

## 開発コマンド

| コマンド            | 内容                                       |
| ------------------- | ------------------------------------------ |
| `pnpm build`        | TypeScriptを`dist`へビルドする             |
| `pnpm typecheck`    | TypeScriptの型を検査する                   |
| `pnpm test`         | Vitestのテストを1回実行する                |
| `pnpm lint`         | ESLintでコードを検査する                   |
| `pnpm format`       | Prettierで対象ファイルを整形する           |
| `pnpm format:check` | Prettierによる整形差分がないことを検査する |
