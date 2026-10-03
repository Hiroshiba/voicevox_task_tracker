import { prepareSequentialPagesEffectChild } from "../infrastructure/tracking-run/sequential-pages-effect-child.js";

const source = process.env["PAGES_EFFECT_PAYLOAD"];
if (source == null) {
  throw new TypeError("Pages childの固定入力がありません");
}
const value: unknown = JSON.parse(source);
await prepareSequentialPagesEffectChild(process.cwd(), value, process.env);
