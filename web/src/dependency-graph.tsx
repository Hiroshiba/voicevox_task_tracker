import { type VNode } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import { type PublicDetailsDto, type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import {
  assertPublicDetailsMatchSummary,
  createComponentGraphView,
  createGraphComponentList,
  createGraphRepositoryList,
  createRepositoryGraphView,
  graphNodeKindLabel,
  graphNodeSeverityLabel,
  MAX_GRAPH_NODE_SIZE,
  type GraphClusterView,
  type GraphComponentListItem,
  type GraphNodeLink,
  type GraphRepositoryListItem,
  type GraphViewEdge,
  type GraphViewNode,
  relationTypeLabel,
} from "./graph-model.js";
import type { GraphLayout, LayoutedGraphNode } from "./graph-layout.js";
import { formatConfidence, formatDateTime } from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";
import type { GraphSelection } from "./url-state.js";

const CLUSTERS_PER_PAGE = 50;

/** details.jsonを検証して返す遅延loader。 */
export type PublicDetailsLoader = () => Promise<PublicDetailsDto>;

type DependencyGraphProps = Readonly<{
  loadDetails: PublicDetailsLoader;
  locale: string;
  now: Date;
  onSelectionChange: (selection: GraphSelection) => void;
  selection: GraphSelection;
  summary: PublicSummaryDto;
}>;

type DetailsState =
  | Readonly<{
      status: "not_requested";
    }>
  | Readonly<{
      status: "loading";
    }>
  | Readonly<{
      status: "loaded";
      details: PublicDetailsDto;
    }>
  | Readonly<{
      status: "failed";
    }>;

type ClusterViewState =
  | Readonly<{
      status: "unavailable";
    }>
  | Readonly<{
      status: "available";
      view: GraphClusterView;
    }>;

type LayoutState =
  | Readonly<{
      status: "loading";
    }>
  | Readonly<{
      status: "loaded";
      layout: GraphLayout;
    }>
  | Readonly<{
      status: "failed";
    }>;

type EdgeHistoryEvent = PublicDetailsDto["graph"]["history"][number];
type EdgeHistoryState = EdgeHistoryEvent["before"];
type EdgeHistoryValue = Extract<EdgeHistoryState, Readonly<{ state: "present" }>>["value"];
type EdgeHistorySelection =
  | Readonly<{
      status: "none";
    }>
  | Readonly<{
      status: "selected";
      relationId: string;
    }>;

type GitHubGraphLinkProps = Readonly<{
  children: string;
  link: GraphNodeLink;
}>;

function GitHubGraphLink({ children, link }: GitHubGraphLinkProps) {
  if (link.status === "unavailable") {
    return <span>{children}</span>;
  }
  return <SafeGitHubLink href={link.url}>{children}</SafeGitHubLink>;
}

function truncateGraphText(value: string, maximumLength: number): string {
  const characters = [...value];
  if (characters.length <= maximumLength) {
    return value;
  }
  return `${characters.slice(0, maximumLength - 1).join("")}…`;
}

function nodeIcon(node: GraphViewNode): string {
  switch (node.kind) {
    case "issue":
      return "ISSUE";
    case "pull_request":
      return "PR";
    case "external_reference":
      return "外部";
    case "dependency_cycle":
      return "循環";
    default:
      throw new UnreachableError(node.kind);
  }
}

function nodeShape(nodeLayout: LayoutedGraphNode) {
  const { node, x, y } = nodeLayout;
  const left = x - node.width / 2;
  const top = y - node.height / 2;
  switch (node.kind) {
    case "issue":
      return (
        <rect x={left} y={top} width={node.width} height={node.height} rx={node.height * 0.2} />
      );
    case "pull_request": {
      const corner = node.height * 0.22;
      return (
        <polygon
          points={[
            `${left + corner},${top}`,
            `${left + node.width - corner},${top}`,
            `${left + node.width},${y}`,
            `${left + node.width - corner},${top + node.height}`,
            `${left + corner},${top + node.height}`,
            `${left},${y}`,
          ].join(" ")}
        />
      );
    }
    case "external_reference":
      return (
        <polygon
          points={[
            `${x},${top}`,
            `${left + node.width},${y}`,
            `${x},${top + node.height}`,
            `${left},${y}`,
          ].join(" ")}
        />
      );
    case "dependency_cycle": {
      const corner = node.height * 0.2;
      return (
        <polygon
          points={[
            `${left + corner},${top}`,
            `${left + node.width - corner},${top}`,
            `${left + node.width},${top + corner}`,
            `${left + node.width},${top + node.height - corner}`,
            `${left + node.width - corner},${top + node.height}`,
            `${left + corner},${top + node.height}`,
            `${left},${top + node.height - corner}`,
            `${left},${top + corner}`,
          ].join(" ")}
        />
      );
    }
    default:
      throw new UnreachableError(node.kind);
  }
}

function graphPath(points: GraphLayout["edges"][number]["points"]): string {
  const firstPoint = points[0];
  assertNonNullable(firstPoint, "graph edgeの始点がありません");
  return [
    `M ${firstPoint.x.toString()} ${firstPoint.y.toString()}`,
    ...points.slice(1).map((point) => `L ${point.x.toString()} ${point.y.toString()}`),
  ].join(" ");
}

function GraphSvg({ layout }: Readonly<{ layout: GraphLayout }>) {
  return (
    <div class="graph-viewport" data-layout-status="ready">
      <svg
        class="dependency-graph-svg"
        viewBox={`0 0 ${layout.width.toString()} ${layout.height.toString()}`}
        width={Math.max(layout.width, 760)}
        height={Math.max(layout.height, 360)}
        role="img"
        aria-labelledby="dependency-graph-title dependency-graph-description"
        data-rendered-node-count={layout.nodes.length}
      >
        <title id="dependency-graph-title">選択したまとまりの依存グラフ</title>
        <desc id="dependency-graph-description">
          矢印は依存関係の始点から終点へ向き、ブロック関係はブロック元からブロックされる項目へ向きます。
        </desc>
        <defs>
          <marker
            id="dependency-graph-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <g class="graph-edges">
          {layout.edges.map(({ edge, points, labelPoint }) => (
            <g
              key={edge.id}
              class={`graph-edge graph-edge-${edge.type} ${
                edge.authoritative ? "graph-edge-authoritative" : "graph-edge-inferred"
              }`}
              data-edge-id={edge.id}
              data-edge-type={edge.type}
              data-authority={edge.authoritative ? "authoritative" : "inferred"}
            >
              <path d={graphPath(points)} marker-end="url(#dependency-graph-arrow)" />
              <text x={labelPoint.x} y={labelPoint.y - 5}>
                <tspan x={labelPoint.x}>{edge.typeLabel}</tspan>
                <tspan x={labelPoint.x} dy="1.15em">
                  {edge.authorityLabel}
                </tspan>
              </text>
            </g>
          ))}
        </g>
        <g class="graph-nodes">
          {layout.nodes.map((nodeLayout) => {
            const { node, x, y } = nodeLayout;
            const frontierLabel = node.frontier ? "、着手可能な項目" : "";
            const cycleLabel = node.cycleIds.length > 0 ? "、循環関係を構成する項目" : "";
            return (
              <g
                key={node.id}
                class={`graph-node graph-node-${node.kind} graph-severity-${node.severity} ${
                  node.cycleIds.length > 0 ? "graph-node-cycle-member" : ""
                }`}
                data-node-id={node.id}
                data-node-kind={node.kind}
                data-frontier={node.frontier ? "true" : "false"}
                role="group"
                aria-label={`${graphNodeKindLabel(node.kind)}、${node.reference}、${node.title}${frontierLabel}${cycleLabel}`}
              >
                <title>
                  {node.reference} {node.title}
                </title>
                {nodeShape(nodeLayout)}
                <text class="graph-node-icon" x={x} y={y - node.height * 0.25}>
                  {nodeIcon(node)}
                </text>
                <text class="graph-node-reference" x={x} y={y - 2}>
                  {truncateGraphText(node.reference, 28)}
                </text>
                <text class="graph-node-title" x={x} y={y + node.height * 0.2}>
                  {truncateGraphText(node.title, 32)}
                </text>
                {node.frontier && (
                  <text class="graph-frontier-label" x={x} y={y + node.height * 0.39}>
                    ▶ 着手可能
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function GraphCanvas({ view }: Readonly<{ view: GraphClusterView }>) {
  const [layoutState, setLayoutState] = useState<LayoutState>({
    status: "loading",
  });

  useEffect(() => {
    let active = true;
    setLayoutState({
      status: "loading",
    });
    void import("./graph-layout.js")
      .then(({ layoutGraphCluster }) => layoutGraphCluster(view))
      .then((layout) => {
        if (active) {
          setLayoutState({
            status: "loaded",
            layout,
          });
        }
      })
      .catch((error: unknown) => {
        console.error("依存グラフの自動配置に失敗しました", error);
        if (active) {
          setLayoutState({
            status: "failed",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [view]);

  switch (layoutState.status) {
    case "loading":
      return (
        <p class="graph-loading" role="status" data-layout-status="loading">
          選択したグラフを自動配置しています。
        </p>
      );
    case "loaded":
      return <GraphSvg layout={layoutState.layout} />;
    case "failed":
      return (
        <p class="notice notice-warning" role="alert" data-layout-status="failed">
          グラフを自動配置できませんでした。表形式の情報は引き続き確認できます。
        </p>
      );
    default:
      throw new UnreachableError(layoutState);
  }
}

function GraphLegend() {
  const edgeTypes: readonly GraphViewEdge["type"][] = [
    "blocks",
    "parent_of",
    "implements",
    "related_to",
    "duplicates",
  ];

  function relationDirectionDescription(type: GraphViewEdge["type"]): string {
    switch (type) {
      case "blocks":
        return "ブロック元からブロックされる項目へ";
      case "parent_of":
        return "親項目から子項目へ";
      case "implements":
        return "実装する項目から対象項目へ";
      case "related_to":
        return "参照元から参照先へ";
      case "duplicates":
        return "重複元から重複先へ";
      default:
        throw new UnreachableError(type);
    }
  }

  return (
    <aside class="graph-legend" aria-labelledby="graph-legend-heading">
      <details>
        <summary>
          <h3 id="graph-legend-heading">図の見方と凡例</h3>
        </summary>
        <div class="graph-legend-content">
          <div class="graph-legend-groups">
            <div>
              <h4>項目の図形</h4>
              <ul>
                <li>
                  <span class="legend-node legend-node-issue" aria-hidden="true">
                    ISSUE
                  </span>
                  <span>
                    <strong>Issue</strong>
                    <small>GitHubの課題</small>
                  </span>
                </li>
                <li>
                  <span class="legend-node legend-node-pull-request" aria-hidden="true">
                    PR
                  </span>
                  <span>
                    <strong>Pull Request</strong>
                    <small>GitHubへの変更提案</small>
                  </span>
                </li>
                <li>
                  <span class="legend-node legend-node-external-reference" aria-hidden="true">
                    外部
                  </span>
                  <span>
                    <strong>外部参照</strong>
                    <small>追跡対象外の参照先</small>
                  </span>
                </li>
                <li>
                  <span class="legend-node legend-node-dependency-cycle" aria-hidden="true">
                    循環
                  </span>
                  <span>
                    <strong>循環関係</strong>
                    <small>互いにブロックする項目をまとめた図形</small>
                  </span>
                </li>
              </ul>
            </div>
            <div>
              <h4>依存関係の線</h4>
              <ul>
                {edgeTypes.map((type) => (
                  <li key={type} data-legend-edge-type={type}>
                    <span class={`legend-edge legend-edge-${type}`} aria-hidden="true" />
                    <span>
                      <strong>{relationTypeLabel(type)}</strong>
                      <small>
                        <code>{type}</code>・{relationDirectionDescription(type)}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4>判定と強調</h4>
              <ul>
                <li>
                  <span class="legend-edge graph-edge-authoritative" aria-hidden="true" />
                  <span>
                    <strong>確定関係</strong>
                    <small>GitHubの正式な関係</small>
                  </span>
                </li>
                <li>
                  <span class="legend-edge graph-edge-inferred" aria-hidden="true" />
                  <span>
                    <strong>推定関係</strong>
                    <small>本文や参照などから判定した関係</small>
                  </span>
                </li>
                <li>
                  <span class="legend-frontier" aria-hidden="true">
                    ▶
                  </span>
                  <span>
                    <strong>着手可能</strong>
                    <small>未完了で、ブロック元がない項目</small>
                  </span>
                </li>
              </ul>
            </div>
          </div>
          <p>
            項目の図形は、停滞時間、影響項目数、影響リポジトリ数が増えるほど大きくなります。
            基準サイズは{MAX_GRAPH_NODE_SIZE.toString()}pxが上限です。
          </p>
          <p>すべての矢印は、関係の始点から終点へ向きます。</p>
        </div>
      </details>
    </aside>
  );
}

function formatGraphStallDays(node: GraphViewNode, locale: string): string {
  if (node.kind === "external_reference") {
    return "対象外";
  }
  if (node.stallDays < 1) {
    return `${Math.floor(node.stallDays * 24).toLocaleString(locale)}時間`;
  }
  return `${Math.floor(node.stallDays).toLocaleString(locale)}日`;
}

function edgeEndpointLabel(
  nodeId: string,
  sourceNodesById: ReadonlyMap<string, GraphViewNode>,
): string {
  const node = sourceNodesById.get(nodeId);
  assertNonNullable(node, `edge endpoint ${nodeId}の表示nodeがありません`);
  return node.reference;
}

function GraphAlternativeTables({
  locale,
  view,
}: Readonly<{ locale: string; view: GraphClusterView }>) {
  const sourceNodesById = new Map(view.sourceNodes.map((node) => [node.id, node]));
  return (
    <details class="graph-alternative">
      <summary>項目と依存関係を表で確認</summary>
      <p class="graph-alternative-note">
        図へ最初に表示する上限は{view.maxInitialNodes.toLocaleString(locale)}項目です。
      </p>
      <div class="table-scroll">
        <table class="graph-node-table">
          <caption>選択したまとまりの項目一覧</caption>
          <thead>
            <tr>
              <th scope="col">項目</th>
              <th scope="col">種別</th>
              <th scope="col">状態</th>
              <th scope="col">停滞時間</th>
              <th scope="col">影響範囲</th>
              <th scope="col">着手可能</th>
              <th scope="col">循環関係</th>
            </tr>
          </thead>
          <tbody>
            {view.sourceNodes.map((node) => (
              <tr
                key={node.id}
                data-node-id={node.id}
                data-frontier={node.frontier ? "true" : "false"}
              >
                <th scope="row">
                  <span class="repository-name">{node.repositoryText}</span>
                  <GitHubGraphLink link={node.link}>
                    {`${node.reference} ${node.title}`}
                  </GitHubGraphLink>
                </th>
                <td>
                  <span class={`node-kind-badge node-kind-${node.kind}`}>
                    {graphNodeKindLabel(node.kind)}
                  </span>
                </td>
                <td>
                  {node.statusText}・{node.stateText}・{graphNodeSeverityLabel(node.severity)}
                </td>
                <td>{formatGraphStallDays(node, locale)}</td>
                <td>
                  {node.impactRepositoryCount.toLocaleString(locale)}
                  リポジトリ・{node.impactOpenNodeCount.toLocaleString(locale)}項目
                </td>
                <td>{node.frontier ? "▶ 着手可能" : "いいえ"}</td>
                <td>
                  {node.cycleIds.length === 0 ? "なし" : `循環関係 ${node.cycleIds.join("、")}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="table-scroll">
        <table class="graph-edge-table">
          <caption>選択したまとまりの依存関係一覧</caption>
          <thead>
            <tr>
              <th scope="col">向き</th>
              <th scope="col">関係の種類</th>
              <th scope="col">判定</th>
              <th scope="col">関係の判定元</th>
              <th scope="col">根拠</th>
            </tr>
          </thead>
          <tbody>
            {view.sourceEdges.map((edge) => (
              <tr key={edge.id} data-edge-id={edge.id} data-edge-type={edge.type}>
                <th scope="row">
                  {edgeEndpointLabel(edge.fromNodeId, sourceNodesById)} →{" "}
                  {edgeEndpointLabel(edge.toNodeId, sourceNodesById)}
                </th>
                <td>
                  {edge.typeLabel}
                  <span class="technical-value">{edge.type}</span>
                </td>
                <td>{edge.authorityLabel}</td>
                <td>{edge.provenanceLabel}</td>
                <td>
                  <ul class="edge-evidence-list">
                    {edge.evidence.map((evidence) => (
                      <li key={`${edge.id}:${evidence.sourceId}`}>
                        <SafeGitHubLink href={evidence.sourceUrl}>
                          {evidence.sourceId}
                        </SafeGitHubLink>
                        <span>{evidence.summary}</span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
            {view.sourceEdges.length === 0 && (
              <tr>
                <td colSpan={5}>この表示範囲に依存関係はありません。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function CycleControls({
  expandedCycleIds,
  onToggle,
  view,
}: Readonly<{
  expandedCycleIds: readonly string[];
  onToggle: (cycleId: string) => void;
  view: GraphClusterView;
}>) {
  if (view.cycles.length === 0) {
    return <p class="graph-no-cycles">このまとまりに循環関係はありません。</p>;
  }
  return (
    <section class="graph-cycles" aria-labelledby="graph-cycles-heading">
      <h3 id="graph-cycles-heading">循環関係</h3>
      <ul>
        {view.cycles.map((cycle, index) => {
          const expanded = expandedCycleIds.includes(cycle.id);
          return (
            <li key={cycle.id} data-cycle-id={cycle.id}>
              <div>
                <strong>循環 {index + 1}</strong>
                <span>{cycle.memberNodes.map((node) => node.reference).join(" → ")}</span>
                {!cycle.visible && <span>現在の項目表示上限外です</span>}
              </div>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => {
                  onToggle(cycle.id);
                }}
              >
                {expanded ? "循環をまとめる" : "構成項目を表示"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function presentEdgeHistoryValue(
  state: EdgeHistoryState,
  relationId: string,
  position: "変更前" | "変更後",
): EdgeHistoryValue {
  if (state.state === "absent") {
    throw new TypeError(`edge履歴 ${relationId}の${position}にedgeがありません`);
  }
  return state.value;
}

function edgeHistoryEventOperation(event: EdgeHistoryEvent): "added" | "changed" | "removed" {
  if (event.before.state === "absent") {
    if (event.after.state === "absent") {
      throw new TypeError(`edge履歴 ${event.relationId}の変更前後にedgeがありません`);
    }
    return event.after.value.active ? "added" : "removed";
  }
  if (event.after.state === "absent") {
    return "removed";
  }
  if (!event.before.value.active && event.after.value.active) {
    return "added";
  }
  if (event.before.value.active && !event.after.value.active) {
    return "removed";
  }
  return "changed";
}

function EdgeHistorySnapshot({
  locale,
  value,
}: Readonly<{ locale: string; value: EdgeHistoryValue }>) {
  return (
    <dl class="edge-history-values">
      <div>
        <dt>向き</dt>
        <dd>
          {value.fromNodeId} → {value.toNodeId}
        </dd>
      </div>
      <div>
        <dt>関係の種類</dt>
        <dd>{relationTypeLabel(value.type)}</dd>
      </div>
      <div>
        <dt>確信度</dt>
        <dd>{formatConfidence(value.confidence, locale)}</dd>
      </div>
    </dl>
  );
}

function EdgeHistoryChange({
  after,
  before,
  locale,
}: Readonly<{ after: EdgeHistoryValue; before: EdgeHistoryValue; locale: string }>) {
  return (
    <dl class="edge-history-values edge-history-changes">
      <div>
        <dt>向き</dt>
        <dd>
          <span>
            {before.fromNodeId} → {before.toNodeId}
          </span>
          <span aria-hidden="true">→</span>
          <strong>
            {after.fromNodeId} → {after.toNodeId}
          </strong>
        </dd>
      </div>
      <div>
        <dt>関係の種類</dt>
        <dd>
          <span>{relationTypeLabel(before.type)}</span>
          <span aria-hidden="true">→</span>
          <strong>{relationTypeLabel(after.type)}</strong>
        </dd>
      </div>
      <div>
        <dt>確信度</dt>
        <dd>
          <span>{formatConfidence(before.confidence, locale)}</span>
          <span aria-hidden="true">→</span>
          <strong>{formatConfidence(after.confidence, locale)}</strong>
        </dd>
      </div>
    </dl>
  );
}

function EdgeHistoryEventCard({
  event,
  locale,
  timezone,
}: Readonly<{ event: EdgeHistoryEvent; locale: string; timezone: string }>) {
  const operation = edgeHistoryEventOperation(event);
  let label: string;
  let content: VNode;
  switch (operation) {
    case "added": {
      label = "依存関係を追加";
      const value = presentEdgeHistoryValue(event.after, event.relationId, "変更後");
      content = <EdgeHistorySnapshot value={value} locale={locale} />;
      break;
    }
    case "changed": {
      label = "依存関係を変更";
      const before = presentEdgeHistoryValue(event.before, event.relationId, "変更前");
      const after = presentEdgeHistoryValue(event.after, event.relationId, "変更後");
      content = <EdgeHistoryChange before={before} after={after} locale={locale} />;
      break;
    }
    case "removed": {
      label = "依存関係を削除";
      const value =
        event.before.state === "present"
          ? event.before.value
          : presentEdgeHistoryValue(event.after, event.relationId, "変更後");
      content = <EdgeHistorySnapshot value={value} locale={locale} />;
      break;
    }
    default:
      throw new UnreachableError(operation);
  }
  return (
    <article class="history-event edge-history-event" data-edge-event-kind={operation}>
      <div>
        <h5>{label}</h5>
        <time dateTime={event.recordedAt}>
          {formatDateTime(event.recordedAt, timezone, locale)}
        </time>
      </div>
      {content}
      <p class="history-run-id">Run {event.runId}</p>
    </article>
  );
}

function EdgeHistoryPanel({
  locale,
  timezone,
  view,
}: Readonly<{ locale: string; timezone: string; view: GraphClusterView }>) {
  const [selection, setSelection] = useState<EdgeHistorySelection>({
    status: "none",
  });
  if (view.edgeHistories.length === 0) {
    return (
      <details class="edge-history" aria-labelledby="edge-history-heading">
        <summary>
          <h3 id="edge-history-heading">
            <span>依存関係の変更履歴</span>
            <small>0件</small>
          </h3>
        </summary>
        <p>このまとまりに関係する変更履歴はありません。</p>
      </details>
    );
  }

  let selectedHistory: GraphClusterView["edgeHistories"][number] | undefined;
  if (selection.status === "selected") {
    selectedHistory = view.edgeHistories.find(
      (history) => history.relationId === selection.relationId,
    );
    assertNonNullable(selectedHistory, `選択されたedge履歴 ${selection.relationId}がありません`);
  }

  return (
    <details class="edge-history" aria-labelledby="edge-history-heading">
      <summary>
        <h3 id="edge-history-heading">
          <span>依存関係の変更履歴</span>
          <small>削除済みを含む{view.edgeHistories.length.toLocaleString(locale)}件</small>
        </h3>
      </summary>
      <div class="edge-history-workspace">
        <div class="edge-history-selector">
          <h4>依存関係を選択</h4>
          <ul>
            {view.edgeHistories.map((history) => {
              const selected =
                selection.status === "selected" && selection.relationId === history.relationId;
              const latestEvent = history.events.at(-1);
              assertNonNullable(latestEvent, `edge履歴 ${history.relationId}にeventがありません`);
              const active =
                latestEvent.after.state === "present" && latestEvent.after.value.active;
              return (
                <li key={history.relationId}>
                  <button
                    type="button"
                    class={
                      selected
                        ? "edge-history-button edge-history-button-selected"
                        : "edge-history-button"
                    }
                    data-history-relation-id={history.relationId}
                    aria-controls="selected-edge-history"
                    aria-pressed={selected}
                    onClick={() => {
                      setSelection({
                        status: "selected",
                        relationId: history.relationId,
                      });
                    }}
                  >
                    <strong>
                      {history.fromNodeId} → {history.toNodeId}
                    </strong>
                    <span>{history.relationId}</span>
                    <span>
                      変更{history.events.length.toLocaleString(locale)}件・
                      {active ? "現在有効" : "削除済み"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div id="selected-edge-history" class="selected-edge-history" aria-live="polite">
          {selectedHistory == null ? (
            <p>依存関係を選ぶと、追加、変更、削除の履歴を表示します。</p>
          ) : (
            <>
              <h4>{selectedHistory.relationId}</h4>
              <p>{selectedHistory.events.length.toLocaleString(locale)}件の変更を古い順に表示</p>
              <ol>
                {selectedHistory.events.map((event) => (
                  <li key={`${event.runId}:${event.recordedAt}`}>
                    <EdgeHistoryEventCard event={event} locale={locale} timezone={timezone} />
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </details>
  );
}

function SelectedComponentGraph({
  expandedCycleIds,
  locale,
  onToggleCycle,
  timezone,
  view,
}: Readonly<{
  expandedCycleIds: readonly string[];
  locale: string;
  onToggleCycle: (cycleId: string) => void;
  timezone: string;
  view: GraphClusterView;
}>) {
  return (
    <div class="selected-component-graph">
      <div class="graph-selection-summary" aria-live="polite">
        <p>
          {view.representedSourceNodeCount.toLocaleString(locale)}件の項目を
          {view.renderedNodeCount.toLocaleString(locale)}個の図形で表示します。
        </p>
        {view.omittedSourceNodeCount > 0 && (
          <p>
            上限外の{view.omittedSourceNodeCount.toLocaleString(locale)}件は下の表で確認できます。
          </p>
        )}
      </div>
      <CycleControls view={view} expandedCycleIds={expandedCycleIds} onToggle={onToggleCycle} />
      <GraphLegend />
      <GraphCanvas view={view} />
      <GraphAlternativeTables view={view} locale={locale} />
      <EdgeHistoryPanel
        key={`${view.clusterKind}:${view.clusterId}`}
        view={view}
        locale={locale}
        timezone={timezone}
      />
    </div>
  );
}

type GraphClusterListItem = GraphComponentListItem | GraphRepositoryListItem;

function selectedClusterId(
  selection: Exclude<GraphSelection, Readonly<{ status: "none" }>>,
): string {
  return selection.kind === "component" ? selection.componentId : selection.repositoryId;
}

/** cluster一覧から選択した依存グラフだけを遅延取得して描画する。 */
export function DependencyGraph({
  loadDetails,
  locale,
  now,
  onSelectionChange,
  selection,
  summary,
}: DependencyGraphProps) {
  const components = useMemo(() => createGraphComponentList(summary), [summary]);
  const repositories = useMemo(() => createGraphRepositoryList(summary), [summary]);
  const [clusterKind, setClusterKind] = useState<"component" | "repository">(
    selection.status === "selected" ? selection.kind : "component",
  );
  const [clusterPage, setClusterPage] = useState(0);
  const [detailsState, setDetailsState] = useState<DetailsState>({
    status: "not_requested",
  });
  const [expandedCycleIds, setExpandedCycleIds] = useState<readonly string[]>([]);
  const clusters: readonly GraphClusterListItem[] =
    clusterKind === "component" ? components : repositories;
  const pageCount = Math.max(1, Math.ceil(clusters.length / CLUSTERS_PER_PAGE));
  const visibleClusters = clusters.slice(
    clusterPage * CLUSTERS_PER_PAGE,
    (clusterPage + 1) * CLUSTERS_PER_PAGE,
  );
  const clusterViewState = useMemo<ClusterViewState>(() => {
    if (selection.status === "none" || detailsState.status !== "loaded") {
      return {
        status: "unavailable",
      };
    }
    const expandedCycles = new Set(expandedCycleIds);
    return {
      status: "available",
      view:
        selection.kind === "component"
          ? createComponentGraphView(
              summary,
              detailsState.details,
              selection.componentId,
              expandedCycles,
              now,
            )
          : createRepositoryGraphView(
              summary,
              detailsState.details,
              selection.repositoryId,
              expandedCycles,
              now,
            ),
    };
  }, [detailsState, expandedCycleIds, now, selection, summary]);

  useEffect(() => {
    if (selection.status === "none") {
      return;
    }
    const selectedId = selectedClusterId(selection);
    const selectedClusters = selection.kind === "component" ? components : repositories;
    const selectedIndex = selectedClusters.findIndex((cluster) => cluster.id === selectedId);
    if (selectedIndex < 0) {
      throw new TypeError(`選択された依存グラフclusterがありません: ${selectedId}`);
    }
    setClusterKind(selection.kind);
    setClusterPage(Math.floor(selectedIndex / CLUSTERS_PER_PAGE));
    setExpandedCycleIds([]);
  }, [components, repositories, selection]);

  useEffect(() => {
    if (selection.status === "none" || detailsState.status !== "not_requested") {
      return;
    }
    setDetailsState({
      status: "loading",
    });
    let detailsPromise: Promise<PublicDetailsDto>;
    try {
      detailsPromise = loadDetails();
    } catch (error: unknown) {
      console.error("依存グラフの詳細取得を開始できませんでした", error);
      setDetailsState({
        status: "failed",
      });
      return;
    }
    void detailsPromise
      .then((details) => {
        assertPublicDetailsMatchSummary(summary, details);
        setDetailsState({
          status: "loaded",
          details,
        });
      })
      .catch((error: unknown) => {
        console.error("依存グラフの詳細取得に失敗しました", error);
        setDetailsState({
          status: "failed",
        });
      });
  }, [detailsState.status, loadDetails, selection.status, summary]);

  function changeClusterKind(nextKind: "component" | "repository"): void {
    setClusterKind(nextKind);
    setClusterPage(0);
    setExpandedCycleIds([]);
    if (selection.status === "selected") {
      onSelectionChange({
        status: "none",
      });
    }
  }

  function selectCluster(clusterId: string): void {
    setExpandedCycleIds([]);
    if (detailsState.status === "failed") {
      setDetailsState({
        status: "not_requested",
      });
    }
    onSelectionChange(
      clusterKind === "component"
        ? {
            status: "selected",
            kind: "component",
            componentId: clusterId,
          }
        : {
            status: "selected",
            kind: "repository",
            repositoryId: clusterId,
          },
    );
  }

  function toggleCycle(cycleId: string): void {
    setExpandedCycleIds((currentCycleIds) =>
      currentCycleIds.includes(cycleId)
        ? currentCycleIds.filter((currentCycleId) => currentCycleId !== cycleId)
        : [...currentCycleIds, cycleId].sort(),
    );
  }

  return (
    <section aria-labelledby="dependency-heading" class="section-card dependency-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Dependency graph</p>
          <h2 id="dependency-heading">依存グラフ</h2>
        </div>
        <p>項目間の依存関係から、作業の流れと今着手できる項目を確認します。</p>
      </div>
      <section class="graph-start-guide" aria-labelledby="graph-start-guide-heading">
        <div>
          <p class="graph-guide-step">最初に</p>
          <h3 id="graph-start-guide-heading">確認したいまとまりを選びます</h3>
        </div>
        <div>
          <p>
            一覧から1件選ぶと依存グラフを開きます。
            {summary.graph.clusterByRepository &&
              " リポジトリをまたぐ作業の流れは「つながりごと」、特定のリポジトリだけを見る場合は「リポジトリ別」が向いています。"}
          </p>
          <p>迷ったら、着手可能な項目が多いものや循環関係があるものから確認してください。</p>
        </div>
      </section>
      {components.length === 0 ? (
        <p class="empty-state">表示できる依存関係のまとまりはありません。</p>
      ) : (
        <>
          {summary.graph.clusterByRepository && (
            <fieldset class="graph-cluster-kind">
              <legend>一覧の分け方</legend>
              <label>
                <input
                  type="radio"
                  name="graph-cluster-kind"
                  value="component"
                  checked={clusterKind === "component"}
                  onChange={() => {
                    changeClusterKind("component");
                  }}
                />
                <span>
                  <strong>つながりごと</strong>
                  <small>リポジトリをまたぐ作業の流れを見る</small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="graph-cluster-kind"
                  value="repository"
                  checked={clusterKind === "repository"}
                  onChange={() => {
                    changeClusterKind("repository");
                  }}
                />
                <span>
                  <strong>リポジトリ別</strong>
                  <small>1つのリポジトリ内だけを見る</small>
                </span>
              </label>
            </fieldset>
          )}
          <div class="dependency-workspace">
            <nav
              class="component-browser"
              aria-label={
                clusterKind === "component"
                  ? "依存関係でつながる項目の選択"
                  : "リポジトリ別の項目の選択"
              }
            >
              <div class="component-browser-heading">
                <h3>{clusterKind === "component" ? "つながりを選ぶ" : "リポジトリを選ぶ"}</h3>
                <p>{clusters.length.toLocaleString(locale)}件</p>
              </div>
              <ol start={clusterPage * CLUSTERS_PER_PAGE + 1}>
                {visibleClusters.map((cluster) => {
                  const selected =
                    selection.status === "selected" &&
                    selection.kind === clusterKind &&
                    selectedClusterId(selection) === cluster.id;
                  return (
                    <li key={cluster.id}>
                      <button
                        type="button"
                        class={
                          selected
                            ? "component-button component-button-selected"
                            : "component-button"
                        }
                        data-cluster-id={cluster.id}
                        {...(clusterKind === "component"
                          ? { "data-component-id": cluster.id }
                          : { "data-repository-id": cluster.id })}
                        aria-pressed={selected}
                        disabled={detailsState.status === "loading"}
                        onClick={() => {
                          selectCluster(cluster.id);
                        }}
                      >
                        <strong>{cluster.repositoryText}</strong>
                        <span class="component-button-kind">
                          {clusterKind === "component"
                            ? `つながり ${cluster.ordinal.toLocaleString(locale)}`
                            : "このリポジトリ内"}
                        </span>
                        <span class="component-button-signals">
                          <span
                            class={
                              cluster.frontierCount > 0
                                ? "cluster-signal cluster-signal-ready"
                                : "cluster-signal cluster-signal-neutral"
                            }
                          >
                            着手可能 {cluster.frontierCount.toLocaleString(locale)}件
                          </span>
                          <span
                            class={
                              cluster.cycleCount > 0
                                ? "cluster-signal cluster-signal-cycle"
                                : "cluster-signal cluster-signal-neutral"
                            }
                          >
                            {cluster.cycleCount > 0
                              ? `循環 ${cluster.cycleCount.toLocaleString(locale)}件`
                              : "循環なし"}
                          </span>
                        </span>
                        <span class="component-button-totals">
                          全{cluster.nodeCount.toLocaleString(locale)}項目・依存関係
                          {cluster.edgeCount.toLocaleString(locale)}件
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              {pageCount > 1 && (
                <div class="component-pagination">
                  <button
                    type="button"
                    disabled={clusterPage === 0}
                    onClick={() => {
                      setClusterPage((currentPage) => currentPage - 1);
                    }}
                  >
                    前
                  </button>
                  <span aria-live="polite">
                    {clusterPage + 1} / {pageCount}
                  </span>
                  <button
                    type="button"
                    disabled={clusterPage + 1 >= pageCount}
                    onClick={() => {
                      setClusterPage((currentPage) => currentPage + 1);
                    }}
                  >
                    次
                  </button>
                </div>
              )}
            </nav>
            <div class="component-graph-panel">
              {selection.status === "none" && (
                <p class="graph-placeholder">一覧から1件選ぶと依存グラフを開きます。</p>
              )}
              {selection.status === "selected" && detailsState.status === "loading" && (
                <p class="graph-loading" role="status">
                  選択したまとまりのグラフを取得しています。
                </p>
              )}
              {selection.status === "selected" && detailsState.status === "failed" && (
                <div class="graph-load-failure" role="alert">
                  <p>選択したまとまりのグラフを取得できませんでした。</p>
                  <button
                    type="button"
                    onClick={() => {
                      setDetailsState({
                        status: "not_requested",
                      });
                    }}
                  >
                    再取得
                  </button>
                </div>
              )}
              {clusterViewState.status === "available" && (
                <SelectedComponentGraph
                  view={clusterViewState.view}
                  locale={locale}
                  expandedCycleIds={expandedCycleIds}
                  onToggleCycle={toggleCycle}
                  timezone={summary.timezone}
                />
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
