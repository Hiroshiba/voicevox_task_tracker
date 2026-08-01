# 未実装要件の課題一覧

影響度は、追跡漏れと状態誤判定、障害検知と復旧、監査性、運用指標、Web 機能の順に評価した。

1. repository cluster 単位で graph を閲覧できない

   - 対応する要件 ID: `WEB-004`
   - 現状: clusterByRepository は config schema に存在する `src/config/schema.ts:293`。Web は connected component の選択だけを提供する `web/src/dependency-graph.tsx:692`。
   - 足りない点: repository 単位の cluster 生成、選択、表示がない。

2. edge 履歴を graph 画面で閲覧できない

   - 対応する要件 ID: `GRF-011`
   - 現状: 公開 graph DTO は edge history を持つ `src/pages/public-dto.ts:372`。graph 画面は component の選択と現在の edge 表示だけを実装する `web/src/dependency-graph.tsx:685`。
   - 足りない点: edge の追加、変更、削除履歴を graph 画面で表示する処理がない。

3. staleness.timezone が表示へ反映されない

   - 対応する要件 ID: `WEB-012`
   - 現状: timezone は config schema に存在する `src/config/schema.ts:340`。Web の日時 formatter は Asia/Tokyo を直接指定する `web/src/model.ts:153`。現行設定値も Asia/Tokyo のため表示結果は一致する。
   - 足りない点: 設定した timezone を公開データまたは Web へ渡し、日時表示へ適用する処理がない。
