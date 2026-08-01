# 未実装要件の課題一覧

影響度は、追跡漏れと状態誤判定、障害検知と復旧、監査性、運用指標、Web 機能の順に評価した。

1. staleness.timezone が表示へ反映されない

   - 対応する要件 ID: `WEB-012`
   - 現状: timezone は config schema に存在する `src/config/schema.ts:340`。Web の日時 formatter は Asia/Tokyo を直接指定する `web/src/model.ts:153`。現行設定値も Asia/Tokyo のため表示結果は一致する。
   - 足りない点: 設定した timezone を公開データまたは Web へ渡し、日時表示へ適用する処理がない。
