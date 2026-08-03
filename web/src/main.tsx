import { render } from "preact";

import {
  createPublicDetailsDto,
  createPublicSummaryDto,
  type PublicDetailsDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { App, DataLoadFailure } from "./app.js";

/** 公開summary DTOの取得に失敗したことを表す。 */
class PublicSummaryLoadError extends Error {}

/** 公開details DTOの取得に失敗したことを表す。 */
class PublicDetailsLoadError extends Error {}

async function loadPublicSummary(): Promise<PublicSummaryDto> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/summary.json`, {
    credentials: "omit",
  });
  if (!response.ok) {
    throw new PublicSummaryLoadError(
      `公開summary DTOを取得できません。HTTP statusは${response.status.toString()}です`,
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (error: unknown) {
    throw new PublicSummaryLoadError("公開summary DTOをJSONとして解釈できません", {
      cause: error,
    });
  }
  return createPublicSummaryDto(value);
}

async function loadPublicDetails(): Promise<PublicDetailsDto> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/details.json`, {
    credentials: "omit",
  });
  if (!response.ok) {
    throw new PublicDetailsLoadError(
      `公開details DTOを取得できません。HTTP statusは${response.status.toString()}です`,
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (error: unknown) {
    throw new PublicDetailsLoadError("公開details DTOをJSONとして解釈できません", {
      cause: error,
    });
  }
  return createPublicDetailsDto(value);
}

const root = document.getElementById("app");
if (root == null) {
  throw new Error("Web UIの描画先がありません");
}

document.documentElement.lang = __VOICEVOX_TRACKER_LOCALE__;
document.title = __VOICEVOX_TRACKER_TITLE__;

void loadPublicSummary()
  .then((summary) => {
    render(
      <App
        basePath={import.meta.env.BASE_URL}
        locale={__VOICEVOX_TRACKER_LOCALE__}
        loadDetails={loadPublicDetails}
        now={new Date()}
        summary={summary}
        title={__VOICEVOX_TRACKER_TITLE__}
      />,
      root,
    );
  })
  .catch((error: unknown) => {
    console.error("Web UIの公開データ読み込みに失敗しました", error);
    render(<DataLoadFailure />, root);
  });
