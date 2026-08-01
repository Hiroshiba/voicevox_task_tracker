# 未実装要件の課題一覧

影響度は、追跡漏れと状態誤判定、障害検知と復旧、監査性、運用指標、Web 機能の順に評価した。

1. author と event actor を保存せず検索できない

   - 対応する要件 ID: `COL-007`、`COL-018`、`WEB-010`
   - 現状: 観測値は author と actor 付き event を保持する `src/github/item-normalization.ts:730`。TrackedItem の保存 field には author と event がない `src/domain/types.ts:329`。Web 検索は waitingOn、assignee、label だけを検索対象へ加える `web/src/model.ts:534`。
   - 足りない点: author と event actor を TrackedItem と公開 DTO へ保存し、actor 検索へ含める処理がない。

2. relation contradiction の構造が永続化されない

   - 対応する要件 ID: `GOL-006`、`GRF-005`
   - 現状: reconcile 後の edge は contradiction の verdict、confidence、evidence を持つ `src/graph/reconcile-graph-types.ts:31`。Relation への変換は contradictions を含めない `src/cli/production-runtime.ts:2686`。公開 graph の再構成では空配列に戻す `src/pages/generate-public-data.ts:328`。矛盾の要約だけは relation evidence に残る。
   - 足りない点: contradiction の verdict と confidence を state、history、公開 DTO へ保持する field がない。

3. repository cluster 単位で graph を閲覧できない

   - 対応する要件 ID: `WEB-004`
   - 現状: clusterByRepository は config schema に存在する `src/config/schema.ts:293`。Web は connected component の選択だけを提供する `web/src/dependency-graph.tsx:692`。
   - 足りない点: repository 単位の cluster 生成、選択、表示がない。

4. edge 履歴を graph 画面で閲覧できない

   - 対応する要件 ID: `GRF-011`
   - 現状: 公開 graph DTO は edge history を持つ `src/pages/public-dto.ts:372`。graph 画面は component の選択と現在の edge 表示だけを実装する `web/src/dependency-graph.tsx:685`。
   - 足りない点: edge の追加、変更、削除履歴を graph 画面で表示する処理がない。

5. staleness.timezone が表示へ反映されない

   - 対応する要件 ID: `WEB-012`
   - 現状: timezone は config schema に存在する `src/config/schema.ts:340`。Web の日時 formatter は Asia/Tokyo を直接指定する `web/src/model.ts:153`。現行設定値も Asia/Tokyo のため表示結果は一致する。
   - 足りない点: 設定した timezone を公開データまたは Web へ渡し、日時表示へ適用する処理がない。
