import type { Settings } from "./settings";

const API_ORIGIN = "https://api.github.com";
const GRAPHQL_ENDPOINT = `${API_ORIGIN}/graphql`;
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
          oid
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
 * フォルダ直下のエントリ 1 件。oid は git のオブジェクトの sha（REST の sha と同じ値）。text は blob のときの本文で、tree やバイナリでは null。
 */
export interface FolderEntry {
  name: string;
  type: string;
  oid: string;
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
        entries?: { name: string; type: string; oid: string; object: { text?: string | null } | null }[];
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
    oid: entry.oid,
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

/**
 * 書き込み失敗の種類。帯の文言と、取り直すかどうかはこの種類で決める。
 * conflict は取得した後にファイルが変わっていた（または消えていた）、unknownResult は通信が途切れて結果が分からない。
 */
export type SaveErrorKind = "conflict" | "auth" | "forbidden" | "rateLimit" | "unknownResult" | "unknown";

/**
 * 書き込み失敗を種類別に表すエラー。detail には原因を追うための情報（HTTP ステータスや応答の message）を入れる。トークンは入れない。
 */
export class SaveError extends Error {
  readonly kind: SaveErrorKind;
  readonly detail: string;

  constructor(kind: SaveErrorKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "SaveError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * ファイル 1 つを書き換える内容。sha は取得したときの blob の sha で、GitHub 上のファイルがこれと違えば書き込まれない。
 * sha を省くと新規作成になり、同じパスのファイルが既にあれば書き込まれない（上書きしない）。
 */
export interface FileUpdate {
  path: string;
  content: string;
  sha?: string;
  message: string;
}

interface UpdateFileResponse {
  content?: { sha?: string } | null;
  message?: string;
}

/**
 * REST の contents API（PUT）で、デフォルトブランチのファイル 1 つを書き換えるコミットを作り、書き込んだ blob の sha を返す。
 * 15 秒で打ち切る。失敗は SaveError に変換する。並列に呼ばないこと（GitHub のドキュメントが禁じている）。
 */
export async function updateFile(settings: Settings, update: FileUpdate): Promise<{ sha: string }> {
  let response: Response;
  try {
    response = await fetch(contentsUrl(settings, update.path), {
      method: "PUT",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MILLISECONDS),
      headers: {
        Authorization: `Bearer ${settings.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: update.message, content: toBase64(update.content), ...(update.sha === undefined ? {} : { sha: update.sha }) }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new SaveError("unknownResult", `${TIMEOUT_MILLISECONDS / 1000} 秒以内に応答がありませんでした`);
    }

    throw new SaveError("unknownResult", String(error));
  }

  const body = await readUpdateBody(response);
  const detail = `HTTP ${response.status}${body?.message ? `: ${body.message}` : ""}`;

  if (response.ok) {
    const sha = body?.content?.sha;
    if (typeof sha !== "string") throw new SaveError("unknown", `${detail}（応答に content.sha がありません）`);

    return { sha };
  }

  throw new SaveError(saveErrorKindOf(response), detail);
}

/**
 * 書き込みの応答から失敗の種類を決める。
 * 409 / 404 / 422 は「取得した後にファイルが変わった・消えた」として競合に寄せる（古い sha の応答コードがドキュメントに無いため、安全側に倒す）。
 */
export function saveErrorKindOf(response: Pick<Response, "status" | "headers">): SaveErrorKind {
  const status = response.status;

  if (status === 409 || status === 404 || status === 422) return "conflict";
  if (status === 401) return "auth";
  if (status === 429) return "rateLimit";
  if (status === 403) return response.headers.get("x-ratelimit-remaining") === "0" ? "rateLimit" : "forbidden";

  return "unknown";
}

// 失敗の応答は本文が JSON でないこともある。そのときは message 無しで扱う。
async function readUpdateBody(response: Response): Promise<UpdateFileResponse | null> {
  try {
    return (await response.json()) as UpdateFileResponse;
  } catch (error) {
    console.warn(`[numa-pocket] 書き込みの応答（HTTP ${response.status}）を JSON として読めませんでした`, error);
    return null;
  }
}

function contentsUrl(settings: Settings, path: string): string {
  const segments = [settings.owner, settings.repo].map(encodeURIComponent).join("/");
  const filePath = path.split("/").map(encodeURIComponent).join("/");
  return `${API_ORIGIN}/repos/${segments}/contents/${filePath}`;
}

/**
 * 文字列を UTF-8 のバイト列にしてから base64 にする（btoa に日本語を直接渡すと失敗するため）。
 */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
