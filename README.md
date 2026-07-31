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
| `pnpm build:web`    | 静的サイトを`dist/web`へビルドする         |
| `pnpm dev:web`      | サンプルDTOでWeb UIを起動する              |
| `pnpm typecheck`    | TypeScriptの型を検査する                   |
| `pnpm test`         | Vitestのテストを1回実行する                |
| `pnpm lint`         | ESLintでコードを検査する                   |
| `pnpm format`       | Prettierで対象ファイルを整形する           |
| `pnpm format:check` | Prettierによる整形差分がないことを検査する |

## Web UI

Web UIはViteとPreactを使用します。Preactは小さなランタイムで大量項目の表示をコンポーネントへ分割しやすく、後から依存グラフを追加する場合も状態管理を共通化できるため採用しました。一覧表は50件ずつ描画し、5,000件規模のDTOでもDOM要素が一度に増えないようにしています。

開発時は実データを含まない`web/public/data/summary.json`を読み込みます。Viteの公開パス、画面タイトル、日時localeには`config.yml`の`web`設定を使用します。

attention queueはseverity、設定済みラベルルールのpriorityWeight、影響リポジトリ数、影響項目数、停滞開始時刻の順で決定論的に並べます。
