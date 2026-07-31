import { z } from "zod";

import {
  createEmptyTableFilters,
  type TableColumnKey,
  type TableFilters,
  type TableSort,
} from "./model.js";

const URL_PARAMETER_NAMES: readonly string[] = [
  "q",
  "repo",
  "type",
  "status",
  "waitingOn",
  "stall",
  "blocker",
  "updated",
  "sort",
  "direction",
  "item",
];

const tableColumnKeySchema = z.enum([
  "repository",
  "type",
  "status",
  "waitingOn",
  "stall",
  "blocker",
  "updated",
]);
const sortDirectionSchema = z.enum(["ascending", "descending"]);
const filterValueSchema = z
  .string()
  .max(200)
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code <= 31 || code === 127) {
        return false;
      }
    }
    return true;
  });
const itemNodeIdSchema = z.string().min(1).max(512).regex(/^\S+$/u);

const FILTER_PARAMETER_NAMES = {
  repository: "repo",
  type: "type",
  status: "status",
  waitingOn: "waitingOn",
  stall: "stall",
  blocker: "blocker",
  updated: "updated",
} satisfies Readonly<Record<TableColumnKey, string>>;

/** URLで共有する項目選択。 */
export type ItemSelection =
  | Readonly<{
      status: "none";
    }>
  | Readonly<{
      status: "selected";
      nodeId: string;
    }>;

/** URLで共有する検索、絞り込み、並び順、選択項目。 */
export type WebViewState = Readonly<{
  searchQuery: string;
  tableFilters: TableFilters;
  tableSort: TableSort;
  selection: ItemSelection;
}>;

/** URL状態を検証した結果。 */
export type ParsedWebViewState =
  | Readonly<{
      status: "valid";
      state: WebViewState;
    }>
  | Readonly<{
      status: "sanitized";
      state: WebViewState;
    }>;

type ParsedParameter<Value> =
  | Readonly<{
      status: "absent";
    }>
  | Readonly<{
      status: "valid";
      value: Value;
    }>
  | Readonly<{
      status: "invalid";
    }>;

/** URLを使わない場合の画面状態を作る。 */
export function createDefaultWebViewState(): WebViewState {
  return {
    searchQuery: "",
    tableFilters: createEmptyTableFilters(),
    tableSort: {
      key: "repository",
      direction: "ascending",
    },
    selection: {
      status: "none",
    },
  };
}

function parseParameter<Value>(
  parameters: URLSearchParams,
  name: string,
  schema: z.ZodType<Value>,
): ParsedParameter<Value> {
  const values = parameters.getAll(name);
  if (values.length === 0) {
    return {
      status: "absent",
    };
  }
  if (values.length !== 1) {
    return {
      status: "invalid",
    };
  }
  const result = schema.safeParse(values[0]);
  if (!result.success) {
    return {
      status: "invalid",
    };
  }
  return {
    status: "valid",
    value: result.data,
  };
}

function parameterValueOr<Value>(
  parameter: ParsedParameter<Value>,
  fallback: Value,
): Readonly<{
  invalid: boolean;
  value: Value;
}> {
  switch (parameter.status) {
    case "absent":
      return {
        invalid: false,
        value: fallback,
      };
    case "valid":
      return {
        invalid: false,
        value: parameter.value,
      };
    case "invalid":
      return {
        invalid: true,
        value: fallback,
      };
  }
}

function hasUnknownParameter(parameters: URLSearchParams): boolean {
  const allowedNames = new Set<string>(URL_PARAMETER_NAMES);
  return [...parameters.keys()].some((name) => !allowedNames.has(name));
}

/** query stringを検証し、不正な値だけを安全な既定値へ戻す。 */
export function parseWebViewState(
  search: string,
  validItemNodeIds: ReadonlySet<string>,
): ParsedWebViewState {
  const parameters = new URLSearchParams(search);
  const defaults = createDefaultWebViewState();
  let sanitized = hasUnknownParameter(parameters);

  const searchQuery = parameterValueOr(
    parseParameter(parameters, "q", filterValueSchema),
    defaults.searchQuery,
  );
  sanitized ||= searchQuery.invalid;

  const tableFilters = Object.fromEntries(
    Object.entries(FILTER_PARAMETER_NAMES).map(([key, parameterName]) => {
      const parsed = parameterValueOr(
        parseParameter(parameters, parameterName, filterValueSchema),
        "",
      );
      sanitized ||= parsed.invalid;
      return [key, parsed.value];
    }),
  );
  const parsedTableFilters = z
    .strictObject({
      repository: filterValueSchema,
      type: filterValueSchema,
      status: filterValueSchema,
      waitingOn: filterValueSchema,
      stall: filterValueSchema,
      blocker: filterValueSchema,
      updated: filterValueSchema,
    })
    .parse(tableFilters);

  const sortKey = parameterValueOr(
    parseParameter(parameters, "sort", tableColumnKeySchema),
    defaults.tableSort.key,
  );
  const sortDirection = parameterValueOr(
    parseParameter(parameters, "direction", sortDirectionSchema),
    defaults.tableSort.direction,
  );
  sanitized ||= sortKey.invalid || sortDirection.invalid;

  const selectedItem = parseParameter(parameters, "item", itemNodeIdSchema);
  let selection: ItemSelection;
  switch (selectedItem.status) {
    case "absent":
      selection = {
        status: "none",
      };
      break;
    case "valid":
      if (validItemNodeIds.has(selectedItem.value)) {
        selection = {
          status: "selected",
          nodeId: selectedItem.value,
        };
      } else {
        sanitized = true;
        selection = {
          status: "none",
        };
      }
      break;
    case "invalid":
      sanitized = true;
      selection = {
        status: "none",
      };
      break;
  }

  const state = {
    searchQuery: searchQuery.value,
    tableFilters: parsedTableFilters,
    tableSort: {
      key: sortKey.value,
      direction: sortDirection.value,
    },
    selection,
  };
  return sanitized
    ? {
        status: "sanitized",
        state,
      }
    : {
        status: "valid",
        state,
      };
}

function appendNonEmptyParameter(parameters: URLSearchParams, name: string, value: string): void {
  if (value.length > 0) {
    parameters.set(name, value);
  }
}

/** 検証済み画面状態を同一ページのdeep linkへ変換する。 */
export function createWebViewHref(pathname: string, state: WebViewState): string {
  const parameters = new URLSearchParams();
  appendNonEmptyParameter(parameters, "q", state.searchQuery);
  for (const [key, parameterName] of Object.entries(FILTER_PARAMETER_NAMES)) {
    if (
      key !== "repository" &&
      key !== "type" &&
      key !== "status" &&
      key !== "waitingOn" &&
      key !== "stall" &&
      key !== "blocker" &&
      key !== "updated"
    ) {
      throw new TypeError(`未対応の表列です: ${key}`);
    }
    appendNonEmptyParameter(parameters, parameterName, state.tableFilters[key]);
  }
  if (state.tableSort.key !== "repository") {
    parameters.set("sort", state.tableSort.key);
  }
  if (state.tableSort.direction !== "ascending") {
    parameters.set("direction", state.tableSort.direction);
  }
  if (state.selection.status === "selected") {
    parameters.set("item", state.selection.nodeId);
  }
  const query = parameters.toString();
  const hash = state.selection.status === "selected" ? "#item-details" : "";
  return `${pathname}${query.length === 0 ? "" : `?${query}`}${hash}`;
}
