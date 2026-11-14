import type { Settings } from "./settings";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const TIMEOUT_MILLISECONDS = 15_000;

const FOLDER_QUERY = `
query ($owner: String!, $name: String!, $expr: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expr) {
      __typename
      ... on Tree {
        entries {
          name
          type
          object { ... on Blob { text } }
        }
      }
    }
  }
}`;

/**
 * 取得失敗の種類。画面に出す文言はこの種類で決める。
 */
export type FetchErrorKind = "network" | "auth" | "rateLimit" | "repoNotFound" | "folderNotFound" | "notFolder" | "unknown";

/**
 * 取得失敗を種類別に表すエラー。detail には原因を追うための情報（HTTP ステータスや GraphQL のメッセージ）を入れる。トークンは入れない。
 */
export class FetchError extends Error {
  readonly kind: FetchErrorKind;
  readonly detail: string;

  constructor(kind: FetchErrorKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "FetchError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * フォルダ直下のエントリ 1 件。text は blob のときの本文で、tree やバイナリでは null。
 */
export interface FolderEntry {
  name: string;
  type: string;
  text: string | null;
}

interface GraphQLError {
  type?: string;
  message?: string;
}

interface FolderQueryResponse {
  data?: {
    repository: {
      object: {
        __typename: string;
        entries?: { name: string; type: string; object: { text?: string | null } | null }[];
      } | null;
    } | null;
  } | null;
  errors?: GraphQLError[];
}

/**
 * 設定のリポジトリのデフォルトブランチから、フォルダ直下のエントリを GraphQL 1 回で取得する。
 * 15 秒で打ち切り、通信エラーとして扱う。signal による中断は AbortError のまま投げ直し、それ以外の失敗は FetchError に変換する。
 */
export async function fetchFolderEntries(settings: Settings, signal: AbortSignal): Promise<FolderEntry[]> {
  const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MILLISECONDS)]);

  const response = await post(settings, combinedSignal);
  const body = await readBody(response);

  return toEntries(body);
}

async function post(settings: Settings, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      signal,
      headers: {
        Authorization: `Bearer ${settings.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: FOLDER_QUERY,
        variables: { owner: settings.owner, name: settings.repo, expr: `HEAD:${settings.folder}` },
      }),
    });
  } catch (error) {
    throw toTransportError(error, "network");
  }

  if (response.ok) return response;

  const detail = `HTTP ${response.status}`;
  if (response.status === 401) throw new FetchError("auth", detail);
  if (response.status === 403 || response.status === 429) throw new FetchError("rateLimit", detail);
  throw new FetchError("unknown", detail);
}

async function readBody(response: Response): Promise<FolderQueryResponse> {
  try {
    return (await response.json()) as FolderQueryResponse;
  } catch (error) {
    throw toTransportError(error, "unknown", `HTTP ${response.status}: JSON として読めない応答`);
  }
}

function toEntries(body: FolderQueryResponse): FolderEntry[] {
  const errors = body.errors ?? [];
  const messages = errors.map((error) => error.message ?? "(message なし)").join(" / ");
  const repository = body.data?.repository;

  if (errors.some((error) => error.type === "NOT_FOUND")) throw new FetchError("repoNotFound", messages);
  if (errors.length > 0) throw new FetchError("unknown", messages);
  if (body.data === null || body.data === undefined) throw new FetchError("unknown", "data が無い応答");
  if (repository === null || repository === undefined) throw new FetchError("repoNotFound", "repository が null");

  const object = repository.object;
  if (object === null) throw new FetchError("folderNotFound", "object が null");
  if (object.__typename !== "Tree") throw new FetchError("notFolder", `object は ${object.__typename}`);

  return (object.entries ?? []).map((entry) => ({
    name: entry.name,
    type: entry.type,
    text: entry.object?.text ?? null,
  }));
}

/**
 * 呼び出し側による中断（新しい取得が始まった）かを返す。この場合はエラー表示をしない。
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// 中断は呼び出し側に任せるため、そのまま返す。タイムアウトは通信エラーにする。
function toTransportError(error: unknown, kind: FetchErrorKind, context?: string): unknown {
  if (isAbortError(error)) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new FetchError("network", `${TIMEOUT_MILLISECONDS / 1000} 秒以内に応答がありませんでした`);
  }

  const detail = context === undefined ? String(error) : `${context} (${String(error)})`;
  return new FetchError(kind, detail);
}
