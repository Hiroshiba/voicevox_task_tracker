import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { TimeDisplay } from "./time-display.js";

type RepositoriesPageProps = Readonly<{
  locale: string;
  now: Date;
  summary: PublicSummaryDto;
}>;

type RepositorySummary = PublicSummaryDto["repositories"][number];
type StaleRepositorySummary = RepositorySummary &
  Readonly<{
    freshness: Extract<RepositorySummary["freshness"], Readonly<{ status: "stale" }>>;
  }>;

function isStaleRepository(repository: RepositorySummary): repository is StaleRepositorySummary {
  return repository.freshness.status === "stale";
}

/** リポジトリごとの観測鮮度を表示する。 */
export function RepositoriesPage({ locale, now, summary }: RepositoriesPageProps) {
  const staleRepositories = summary.repositories.filter(isStaleRepository);
  const freshRepositories = summary.repositories.filter(
    (repository) => repository.freshness.status === "fresh",
  );

  return (
    <section aria-labelledby="freshness-heading" class="section-card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Freshness</p>
          <h2 id="freshness-heading">リポジトリの鮮度</h2>
        </div>
        <p>取得に失敗して前回値を表示しているリポジトリから確認できます。</p>
      </div>
      <section class="freshness-attention" aria-labelledby="freshness-attention-heading">
        <div class="freshness-group-heading">
          <div>
            <h3 id="freshness-attention-heading">確認が必要なリポジトリ</h3>
            <p>取得に失敗したため、最後に成功した観測値を表示しています。</p>
          </div>
          <span class="freshness-badge freshness-stale">
            {staleRepositories.length.toLocaleString(locale)}件
          </span>
        </div>
        {staleRepositories.length === 0 ? (
          <p class="freshness-empty">現在、確認が必要なリポジトリはありません。</p>
        ) : (
          <div
            class="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="要確認リポジトリ鮮度表の横スクロール領域"
          >
            <table class="freshness-table freshness-stale-table">
              <caption class="visually-hidden">
                観測の確認が必要なリポジトリの項目数、前回の観測時刻、取得失敗時刻
              </caption>
              <thead>
                <tr>
                  <th scope="col">リポジトリ</th>
                  <th scope="col">項目数</th>
                  <th scope="col">前回の観測</th>
                  <th scope="col">取得失敗</th>
                </tr>
              </thead>
              <tbody>
                {staleRepositories.map((repository) => (
                  <tr
                    key={repository.id}
                    data-repository-id={repository.id}
                    data-freshness={repository.freshness.status}
                    class="stale-row"
                  >
                    <th scope="row">
                      <span class="freshness-repository-name">{repository.fullName}</span>
                      <span class="freshness-badge freshness-stale">古い観測値</span>
                    </th>
                    <td>{repository.itemCount.toLocaleString(locale)}</td>
                    <td>
                      <TimeDisplay
                        label="前回の観測"
                        value={repository.observedAt}
                        now={now}
                        timezone={summary.timezone}
                        locale={locale}
                      />
                    </td>
                    <td>
                      <TimeDisplay
                        label="取得失敗"
                        value={repository.freshness.failedAt}
                        now={now}
                        timezone={summary.timezone}
                        locale={locale}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <details class="freshness-normal">
        <summary>
          <h3>
            <span>正常なリポジトリ</span>
            <small>{freshRepositories.length.toLocaleString(locale)}件</small>
          </h3>
        </summary>
        <p>以下はすべて最新観測です。</p>
        {freshRepositories.length === 0 ? (
          <p class="freshness-empty">正常なリポジトリはありません。</p>
        ) : (
          <div
            class="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="正常なリポジトリ鮮度表の横スクロール領域"
          >
            <table class="freshness-table freshness-fresh-table">
              <caption class="visually-hidden">正常なリポジトリの項目数と最新観測時刻</caption>
              <thead>
                <tr>
                  <th scope="col">リポジトリ</th>
                  <th scope="col">項目数</th>
                  <th scope="col">観測時刻</th>
                </tr>
              </thead>
              <tbody>
                {freshRepositories.map((repository) => (
                  <tr
                    key={repository.id}
                    data-repository-id={repository.id}
                    data-freshness={repository.freshness.status}
                  >
                    <th scope="row">{repository.fullName}</th>
                    <td>{repository.itemCount.toLocaleString(locale)}</td>
                    <td>
                      <TimeDisplay
                        label="観測"
                        value={repository.observedAt}
                        now={now}
                        timezone={summary.timezone}
                        locale={locale}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}
