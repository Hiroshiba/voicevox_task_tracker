# 未実装要件の課題一覧

影響度は、追跡漏れと状態誤判定、障害検知と復旧、監査性、運用指標、Web 機能の順に評価した。

1. Pull Request の reviewState と checkState が unknown のままになる

   - 対応する要件 ID: `COL-009`、`COL-013`、`WEB-009`
   - 現状: 正規化した Pull Request は review、review request、merge state、checks を保持する `src/github/item-normalization.ts:774`。TrackedItem への変換では reviewState と checkState を常に unknown にする `src/cli/production-runtime.ts:2302`。Web はその永続値を表示する `web/src/item-details.tsx:438`。
   - 足りない点: 収集値から集約状態を算出し、snapshot と公開 DTO へ保存する処理がない。

2. automation noise の通知抑制が本番で働かない

   - 対応する要件 ID: `TRK-012`、`NTF-009`
   - 現状: 本番の追跡候補は notificationClass を常に standard にする `src/cli/production-runtime.ts:1061`。通知入力でも常に standard を設定する `src/cli/production-runtime.ts:2828`。通知 selector 側には automation_noise の抑制がある `src/discord/notification-selection.ts:384`。
   - 足りない点: Renovate dashboard などを automation noise に分類し、その分類を通知入力まで保持する処理がない。

3. 判定から AI 再現情報と入力イベントを追跡できない

   - 対応する要件 ID: `GOL-006`、`AIC-015`、`WEB-009`
   - 現状: AI cache entry は再現 metadata を保持する `src/codex/cache.ts:58` が、TrackedItem には metadata への参照がない `src/domain/types.ts:329`。公開 evidence の URL は source ID にかかわらず項目本体の URL を設定する `src/pages/generate-public-data.ts:345`。
   - 足りない点: 各判定を AI cache entry と入力イベントへ結ぶ識別子と、コメントや review などの個別 source を開ける URL がない。

4. GitHub の変更種別が永続化されない

   - 対応する要件 ID: `GOL-006`、`COL-018`、`DAT-004`
   - 現状: 正規化イベントは comment、push、review、review request、label、assignee、state、relation を区別する `src/domain/types.ts:255`。history schema が保存するのは責務、severity、edge、repository 除外だけである `src/persistence/history.ts:93`。
   - 足りない点: 正規化イベントの ID、種別、actor、発生時刻を snapshot または history へ保存する処理がない。

5. state schema の version dispatch と migration がない

   - 対応する要件 ID: `DAT-003`
   - 現状: StateSnapshot は schemaVersion 1 固定である `src/persistence/snapshot.ts:119`。読み取りは JSON を現行 schema へ直接渡す `src/persistence/snapshot.ts:383`。history も version 1 の literal で検証する `src/persistence/history.ts:127`。
   - 足りない点: 読み取った version ごとの parser dispatch と、旧 version を現行 version へ変換する migration がない。

6. 永続 run report の時間と通知件数が実績を表さない

   - 対応する要件 ID: `NTF-001`、`OPS-003`
   - 現状: state 用 metrics は durationMilliseconds を 0 にし `src/cli/production-runtime.ts:3027`、finishedAt に startedAt を設定する `src/cli/production-runtime.ts:3046`。Discord の実送信数は後から算出される `src/cli/production-runtime.ts:3249`。workflow は collect-analyze に予定時刻を渡さない `.github/workflows/daily.yml:102`。
   - 足りない点: workflow 完了時の実所要時間と実送信数で report を確定する処理と、予定時刻からの schedule 遅延を計測する入力がない。

7. Codex の notification recommendation が通知選別へ渡らない

   - 対応する要件 ID: `AIC-020`、`NTF-006`
   - 現状: reducer は検証済み出力から notification recommendation を生成する `src/codex/reducer.ts:315`。本番は reducer 結果から decision と relation assessment だけを取り出す `src/cli/production-runtime.ts:2396`。
   - 足りない点: 検証済み recommendation を通知 selector の候補データへ渡し、定式ルールと統合する処理がない。

8. author と event actor を保存せず検索できない

   - 対応する要件 ID: `COL-007`、`COL-018`、`WEB-010`
   - 現状: 観測値は author と actor 付き event を保持する `src/github/item-normalization.ts:730`。TrackedItem の保存 field には author と event がない `src/domain/types.ts:329`。Web 検索は waitingOn、assignee、label だけを検索対象へ加える `web/src/model.ts:534`。
   - 足りない点: author と event actor を TrackedItem と公開 DTO へ保存し、actor 検索へ含める処理がない。

9. relation contradiction の構造が永続化されない

   - 対応する要件 ID: `GOL-006`、`GRF-005`
   - 現状: reconcile 後の edge は contradiction の verdict、confidence、evidence を持つ `src/graph/reconcile-graph-types.ts:31`。Relation への変換は contradictions を含めない `src/cli/production-runtime.ts:2686`。公開 graph の再構成では空配列に戻す `src/pages/generate-public-data.ts:328`。矛盾の要約だけは relation evidence に残る。
   - 足りない点: contradiction の verdict と confidence を state、history、公開 DTO へ保持する field がない。

10. repository cluster 単位で graph を閲覧できない

    - 対応する要件 ID: `WEB-004`
    - 現状: clusterByRepository は config schema に存在する `src/config/schema.ts:293`。Web は connected component の選択だけを提供する `web/src/dependency-graph.tsx:692`。
    - 足りない点: repository 単位の cluster 生成、選択、表示がない。

11. edge 履歴を graph 画面で閲覧できない

    - 対応する要件 ID: `GRF-011`
    - 現状: 公開 graph DTO は edge history を持つ `src/pages/public-dto.ts:372`。graph 画面は component の選択と現在の edge 表示だけを実装する `web/src/dependency-graph.tsx:685`。
    - 足りない点: edge の追加、変更、削除履歴を graph 画面で表示する処理がない。

12. staleness.timezone が表示へ反映されない

    - 対応する要件 ID: `WEB-012`
    - 現状: timezone は config schema に存在する `src/config/schema.ts:340`。Web の日時 formatter は Asia/Tokyo を直接指定する `web/src/model.ts:153`。現行設定値も Asia/Tokyo のため表示結果は一致する。
    - 足りない点: 設定した timezone を公開データまたは Web へ渡し、日時表示へ適用する処理がない。
