import { useEffect, useMemo, useState } from "preact/hooks";

import { type PublicDetailsDto, type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import {
  assertPublicDetailsMatchSummary,
  createComponentGraphView,
  createGraphComponentList,
  graphNodeKindLabel,
  graphNodeSeverityLabel,
  MAX_GRAPH_NODE_SIZE,
  type ComponentGraphView,
  type GraphNodeLink,
  type GraphViewEdge,
  type GraphViewNode,
} from "./graph-model.js";
import type { GraphLayout, LayoutedGraphNode } from "./graph-layout.js";
import { validateGitHubUrl } from "./model.js";

const COMPONENTS_PER_PAGE = 50;

/** details.jsonを検証して返す遅延loader。 */
export type PublicDetailsLoader = () => Promise<PublicDetailsDto>;

type DependencyGraphProps = Readonly<{
  loadDetails: PublicDetailsLoader;
  locale: string;
  now: Date;
  summary: PublicSummaryDto;
}>;

type ComponentSelection =
  | Readonly<{
      status: "none";
    }>
  | Readonly<{
      status: "selected";
      componentId: string;
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

type ComponentViewState =
  | Readonly<{
      status: "unavailable";
    }>
  | Readonly<{
      status: "available";
      view: ComponentGraphView;
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

type GitHubGraphLinkProps = Readonly<{
  children: string;
  link: GraphNodeLink;
}>;

function GitHubGraphLink({ children, link }: GitHubGraphLinkProps) {
  if (link.status === "unavailable") {
    return <span>{children}</span>;
  }
  const result = validateGitHubUrl(link.url);
  if (!result.allowed) {
    return <span class="unsafe-link">安全でないリンクを無効化しました</span>;
  }
  return (
    <a href={result.url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
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
      return "CYCLE";
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
        <title id="dependency-graph-title">選択したcomponentの依存グラフ</title>
        <desc id="dependency-graph-description">
          矢印は関係の始点から終点へ向き、blocksはblockerからblocked itemへ向きます。
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
            const frontierLabel = node.frontier ? "、着手可能なfrontier" : "";
            const cycleLabel = node.cycleIds.length > 0 ? "、dependency cycle構成node" : "";
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

function GraphCanvas({ view }: Readonly<{ view: ComponentGraphView }>) {
  const [layoutState, setLayoutState] = useState<LayoutState>({
    status: "loading",
  });

  useEffect(() => {
    let active = true;
    setLayoutState({
      status: "loading",
    });
    void import("./graph-layout.js")
      .then(({ layoutComponentGraph }) => layoutComponentGraph(view))
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
  return (
    <aside class="graph-legend" aria-labelledby="graph-legend-heading">
      <h3 id="graph-legend-heading">凡例</h3>
      <div class="graph-legend-groups">
        <div>
          <h4>node種別</h4>
          <ul>
            <li>
              <span class="legend-node legend-node-issue" aria-hidden="true">
                ISSUE
              </span>
              Issue
            </li>
            <li>
              <span class="legend-node legend-node-pull-request" aria-hidden="true">
                PR
              </span>
              Pull Request
            </li>
            <li>
              <span class="legend-node legend-node-external-reference" aria-hidden="true">
                外部
              </span>
              外部参照
            </li>
            <li>
              <span class="legend-node legend-node-dependency-cycle" aria-hidden="true">
                CYCLE
              </span>
              折り畳んだdependency cycle
            </li>
          </ul>
        </div>
        <div>
          <h4>edge種別</h4>
          <ul>
            {edgeTypes.map((type) => (
              <li key={type}>
                <span class={`legend-edge legend-edge-${type}`} aria-hidden="true" />
                {type}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>関係と強調</h4>
          <ul>
            <li>
              <span class="legend-edge graph-edge-authoritative" aria-hidden="true" />
              確定関係
            </li>
            <li>
              <span class="legend-edge graph-edge-inferred" aria-hidden="true" />
              推定関係
            </li>
            <li>
              <span class="legend-frontier" aria-hidden="true">
                ▶
              </span>
              着手可能なfrontier
            </li>
          </ul>
        </div>
      </div>
      <p>
        nodeは停滞時間と影響項目数、影響リポジトリ数が増えるほど大きくなります。 nodeの基準サイズは
        {MAX_GRAPH_NODE_SIZE.toString()}pxを上限とします。
      </p>
      <p>blocksの矢印はblockerからblocked itemへ向きます。</p>
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
}: Readonly<{ locale: string; view: ComponentGraphView }>) {
  const sourceNodesById = new Map(view.sourceNodes.map((node) => [node.id, node]));
  return (
    <details class="graph-alternative">
      <summary>グラフと同じ情報を表形式で確認</summary>
      <div class="table-scroll">
        <table class="graph-node-table">
          <caption>選択したcomponentのnode一覧</caption>
          <thead>
            <tr>
              <th scope="col">項目</th>
              <th scope="col">種別</th>
              <th scope="col">status</th>
              <th scope="col">停滞時間</th>
              <th scope="col">影響範囲</th>
              <th scope="col">frontier</th>
              <th scope="col">cycle</th>
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
                <td>{node.frontier ? "▶ 着手可能" : "frontierではない"}</td>
                <td>
                  {node.cycleIds.length === 0
                    ? "cycleなし"
                    : `dependency cycle ${node.cycleIds.join("、")}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="table-scroll">
        <table class="graph-edge-table">
          <caption>選択したcomponentのedge一覧</caption>
          <thead>
            <tr>
              <th scope="col">向き</th>
              <th scope="col">関係型</th>
              <th scope="col">確度</th>
              <th scope="col">provenance</th>
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
                <td>{edge.typeLabel}</td>
                <td>{edge.authorityLabel}</td>
                <td>{edge.provenanceLabel}</td>
                <td>
                  <ul class="edge-evidence-list">
                    {edge.evidence.map((evidence) => (
                      <li key={`${edge.id}:${evidence.sourceId}`}>
                        <a href={evidence.sourceUrl} target="_blank" rel="noopener noreferrer">
                          {evidence.sourceId}
                        </a>
                        <span>{evidence.summary}</span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
            {view.sourceEdges.length === 0 && (
              <tr>
                <td colSpan={5}>この表示範囲にedgeはありません。</td>
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
  view: ComponentGraphView;
}>) {
  if (view.cycles.length === 0) {
    return <p class="graph-no-cycles">このcomponentにdependency cycleはありません。</p>;
  }
  return (
    <section class="graph-cycles" aria-labelledby="graph-cycles-heading">
      <h3 id="graph-cycles-heading">dependency cycle</h3>
      <ul>
        {view.cycles.map((cycle, index) => {
          const expanded = expandedCycleIds.includes(cycle.id);
          return (
            <li key={cycle.id} data-cycle-id={cycle.id}>
              <div>
                <strong>cycle {index + 1}</strong>
                <span>{cycle.memberNodes.map((node) => node.reference).join(" → ")}</span>
                {!cycle.visible && <span>現在のnode上限外です</span>}
              </div>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => {
                  onToggle(cycle.id);
                }}
              >
                {expanded ? "cycleを折り畳む" : "構成nodeを展開"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SelectedComponentGraph({
  expandedCycleIds,
  locale,
  onToggleCycle,
  view,
}: Readonly<{
  expandedCycleIds: readonly string[];
  locale: string;
  onToggleCycle: (cycleId: string) => void;
  view: ComponentGraphView;
}>) {
  return (
    <div class="selected-component-graph">
      <div class="graph-selection-summary" aria-live="polite">
        <p>
          {view.representedSourceNodeCount.toLocaleString(locale)}件のnodeを
          {view.renderedNodeCount.toLocaleString(locale)}個の図形で表示します。
        </p>
        <p>
          初期表示上限は{view.maxInitialNodes.toLocaleString(locale)}個です。
          {view.omittedSourceNodeCount > 0 &&
            ` 上限外の${view.omittedSourceNodeCount.toLocaleString(locale)}件は全項目一覧で確認できます。`}
        </p>
      </div>
      <CycleControls view={view} expandedCycleIds={expandedCycleIds} onToggle={onToggleCycle} />
      <GraphCanvas view={view} />
      <GraphAlternativeTables view={view} locale={locale} />
    </div>
  );
}

/** component一覧から選択した依存グラフだけを遅延取得して描画する。 */
export function DependencyGraph({ loadDetails, locale, now, summary }: DependencyGraphProps) {
  const components = useMemo(() => createGraphComponentList(summary), [summary]);
  const [componentPage, setComponentPage] = useState(0);
  const [selection, setSelection] = useState<ComponentSelection>({
    status: "none",
  });
  const [detailsState, setDetailsState] = useState<DetailsState>({
    status: "not_requested",
  });
  const [expandedCycleIds, setExpandedCycleIds] = useState<readonly string[]>([]);
  const pageCount = Math.max(1, Math.ceil(components.length / COMPONENTS_PER_PAGE));
  const visibleComponents = components.slice(
    componentPage * COMPONENTS_PER_PAGE,
    (componentPage + 1) * COMPONENTS_PER_PAGE,
  );
  const componentViewState = useMemo<ComponentViewState>(() => {
    if (selection.status === "none" || detailsState.status !== "loaded") {
      return {
        status: "unavailable",
      };
    }
    return {
      status: "available",
      view: createComponentGraphView(
        summary,
        detailsState.details,
        selection.componentId,
        new Set(expandedCycleIds),
        now,
      ),
    };
  }, [detailsState, expandedCycleIds, now, selection, summary]);

  function selectComponent(componentId: string): void {
    setSelection({
      status: "selected",
      componentId,
    });
    setExpandedCycleIds([]);
    if (detailsState.status === "loaded" || detailsState.status === "loading") {
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
        <p>connected componentを選ぶと、そのcomponentだけを取得して自動配置します。</p>
      </div>
      <GraphLegend />
      {components.length === 0 ? (
        <p class="empty-state">表示できる依存componentはありません。</p>
      ) : (
        <div class="dependency-workspace">
          <nav class="component-browser" aria-label="依存componentの選択">
            <div class="component-browser-heading">
              <h3>connected component</h3>
              <p>{components.length.toLocaleString(locale)}件</p>
            </div>
            <ol start={componentPage * COMPONENTS_PER_PAGE + 1}>
              {visibleComponents.map((component) => {
                const selected =
                  selection.status === "selected" && selection.componentId === component.id;
                return (
                  <li key={component.id}>
                    <button
                      type="button"
                      class={
                        selected ? "component-button component-button-selected" : "component-button"
                      }
                      data-component-id={component.id}
                      aria-pressed={selected}
                      disabled={detailsState.status === "loading"}
                      onClick={() => {
                        selectComponent(component.id);
                      }}
                    >
                      <strong>component {component.ordinal.toLocaleString(locale)}</strong>
                      <span>{component.repositoryText}</span>
                      <span>
                        {component.nodeCount.toLocaleString(locale)} node・
                        {component.edgeCount.toLocaleString(locale)} edge
                      </span>
                      <span>
                        frontier {component.frontierCount.toLocaleString(locale)}・cycle{" "}
                        {component.cycleCount.toLocaleString(locale)}
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
                  disabled={componentPage === 0}
                  onClick={() => {
                    setComponentPage((currentPage) => currentPage - 1);
                  }}
                >
                  前
                </button>
                <span aria-live="polite">
                  {componentPage + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  disabled={componentPage + 1 >= pageCount}
                  onClick={() => {
                    setComponentPage((currentPage) => currentPage + 1);
                  }}
                >
                  次
                </button>
              </div>
            )}
          </nav>
          <div class="component-graph-panel">
            {selection.status === "none" && (
              <p class="graph-placeholder">componentを選ぶと依存グラフを開きます。</p>
            )}
            {selection.status === "selected" && detailsState.status === "loading" && (
              <p class="graph-loading" role="status">
                選択したcomponentのグラフを取得しています。
              </p>
            )}
            {selection.status === "selected" && detailsState.status === "failed" && (
              <div class="graph-load-failure" role="alert">
                <p>選択したcomponentのグラフを取得できませんでした。</p>
                <button
                  type="button"
                  onClick={() => {
                    selectComponent(selection.componentId);
                  }}
                >
                  再取得
                </button>
              </div>
            )}
            {componentViewState.status === "available" && (
              <SelectedComponentGraph
                view={componentViewState.view}
                locale={locale}
                expandedCycleIds={expandedCycleIds}
                onToggleCycle={toggleCycle}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
