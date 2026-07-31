# 実装計画

VOICEVOX Organization全体の公開Issue/PRについて、状態・ボールの所在・停滞時間・依存関係を自動整理し、GitHub PagesとDiscordへ提示するシステムを実装する。

## 方針

- Node.js + TypeScript strict、pnpm、Vitestを用いる
- `domain`と`graph`はnetworkとfilesystemに依存しないpure TypeScriptとし、fixture replayで同一結果を得る
- GitHubの確定情報による決定論的判定を先に行い、Codexは曖昧な差分だけに限定する
- 追跡対象リポジトリへの書き込みAPIは一切呼ばない
- publicリポジトリ由来のデータだけを保存・公開し、違反が1件でもあれば公開を中止する

## タスク

各タスクはCodexへ1つずつ依頼し、完了ごとにレビューしてcommitする。

### Phase 0: 基盤

- [x] T01 リポジトリ初期化 — package.json、pnpm、TypeScript strict設定、Vitest、ESLint、Prettier、.gitignore、最小のREADME
- [x] T02 設定の読み込みと検証 — config.yml、config schema、YAMLロード、schemaVersion検証、semantic検証、team slug未設定時の安全停止
- [x] T03 ドメイン型定義 — Repository、TrackedItem、Relation、AnalysisMetadata、NotificationLedger、status/waitingOn enum、正規化イベントとsource ID規約

### Phase 1: GitHub収集

- [x] T04 GitHub App認証とAPIクライアント — installation token発行、Octokit REST/GraphQL、rate limit監視、指数backoff+jitter retry
- [x] T05 リポジトリインベントリと公開境界 — Organization repositoriesのページネーション、public/non-archived/non-disabled allowlistのrun内固定、allowlist外へのAPI呼び出し禁止
- [x] T06 項目列挙と増分収集 — repo単位のopen Issue/PR全ページ取得、fingerprint、前回成功時刻からのoverlap付き増分、event IDでの重複排除
- [x] T07 詳細収集 — issue comments、reviews、review threads、review requests、head SHA、checks/statuses、timeline、native dependency、sub-issue、inbound cross-reference
- [x] T08 正規化 — 収集結果を安定したsource ID付き正規化イベントへ変換、変更種別の保持、stale repo処理

### Phase 2: 決定論的判定

- [x] T09 アクター・ラベル・チーム解決 — bot判定、label rules、既定チームとrepo別上書きの解決
- [x] T10 PR状態機械 — terminal、blocked、automation、changes requested、re-review、review request、draft、ready to merge、CI失敗、conflictの優先順位判定
- [x] T11 Issue状態機械 — terminal、blocked、未回答の明示依頼、assignee、未アサイン時のmaintainer責務
- [x] T12 停滞時間とseverity — statusSince、ownerSince、stallSince、lastProgressAtの算出、bot activityによるリセット禁止、wait class別閾値、priority labelによる引き上げ
- [x] T13 追跡ライフサイクル — startAt確定、追跡対象への追加規則、明示include、backfill、terminal保持と再分析抑制

### Phase 3: 依存グラフ

- [x] T14 関係候補抽出 — native dependency、sub-issue、closing keyword、checklist階層、cross-reference、plain linkの候補化と種別区別
- [ ] T15 グラフreconcile — authoritative/inferred edgeのマージ、根拠消滅時の切断、edge履歴
- [ ] T16 グラフ解析 — cycle検知、actionable frontier、downstream impact、cross-repo component、隣接変化の伝播

### Phase 4: Codex連携

- [ ] T17 Codex adapter — 空の一時作業ディレクトリ、read-only sandbox、承認なし、環境変数の隔離、`--output-schema`によるStructured Output
- [ ] T18 AI cacheと予算管理 — content-addressed cache、call/文字数/費用上限、予算超過時の優先順位、旧結果の安全再利用
- [ ] T19 出力検証とreducer統合 — JSON Schema検証、候補参照とnative relation保護のsemantic検証、AI失敗時のfallback、AI非書込の担保

### Phase 5: 永続化

- [ ] T20 state永続化 — canonical JSON、snapshot、日次history、ai-cache、notification ledger、tracker-state branchへのatomic commit、secret/private sentinel検査

### Phase 6: Webページ

- [ ] T21 公開DTO生成 — Pages用DTOの生成、private data guard、全文転載の回避、gzipサイズ制約
- [ ] T22 Web UI基盤と一覧 — Viteビルド、概要dashboard、attention queue、sort/filter可能な表、鮮度表示
- [ ] T23 Web UI依存グラフ — component単位のグラフ描画、停滞時間とdownstream impactの視覚強調、frontier/cycle表示、凡例
- [ ] T24 Web UI詳細と横断機能 — item詳細、検索、deep link、アクセシビリティ、XSS対策とCSP

### Phase 7: Discord通知

- [ ] T25 通知選別 — 通知候補の抽出、noise抑制、ledgerによる重複抑制とcooldown
- [ ] T26 digest送信 — payload構成、Discord制限に応じた分割、mention allowlist、空digest抑制、運用障害通知

### Phase 8: 実行基盤

- [ ] T27 CLI — daily、dry-run、backfill、replay、evalの各サブコマンドとrun report出力
- [ ] T28 GitHub Actions workflow — 日次workflowのjob分離と最小権限、full commit SHA pin、Pages deploy、CI workflow
- [ ] T29 golden evalとfixture — 実運用パターンを模したfixture一式、回帰評価、受入試験の整備

### Phase 9: 仕上げ

- [ ] T30 ドキュメント整備 — README、アーキテクチャ、デプロイ手順、運用手順
- [ ] T31 動作確認 — ビルド、テスト、Playwrightによる公開ページの動作確認
- [ ] T32 全体レビューと修正 — 要求との突き合わせ、抜けの補完
