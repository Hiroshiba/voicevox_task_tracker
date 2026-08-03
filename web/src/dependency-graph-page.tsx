import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { DependencyGraph, type PublicDetailsLoader } from "./dependency-graph.js";
import { type GraphSelection } from "./url-state.js";

type DependencyGraphPageProps = Readonly<{
  loadDetails: PublicDetailsLoader;
  locale: string;
  now: Date;
  onSelectionChange: (selection: GraphSelection) => void;
  selection: GraphSelection;
  summary: PublicSummaryDto;
}>;

/** cluster一覧と選択した依存グラフを表示する。 */
export function DependencyGraphPage(props: DependencyGraphPageProps) {
  return <DependencyGraph {...props} />;
}
