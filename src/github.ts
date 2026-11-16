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
 * conflict は取得した後にファイルが変わっていた（または消えていた）、exists はリネーム先の名前のファイルが既にあった、unknownResult は通信が途切れて結果が分からない。
 */
export type SaveErrorKind = "conflict" | "exists" | "auth" | "forbidden" | "rateLimit" | "unknownResult" | "unknown";

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
  const body = { message: update.message, content: toBase64(update.content), ...(update.sha === undefined ? {} : { sha: update.sha }) };
  const response = await sendWrite(settings, contentsUrl(settings, update.path), "PUT", body, "unknownResult");

  const responseBody = await readUpdateBody(response);
  const detail = `HTTP ${response.status}${responseBody?.message ? `: ${responseBody.message}` : ""}`;

  if (response.ok) {
    const sha = responseBody?.content?.sha;
    if (typeof sha !== "string") throw new SaveError("unknown", `${detail}（応答に content.sha がありません）`);

    return { sha };
  }

  throw new SaveError(saveErrorKindOf(response), detail);
}

/**
 * 消すファイル。sha は取得したときの blob の sha で、GitHub 上のファイルがこれと違えば消されない。
 */
export interface FileDeletion {
  path: string;
  sha: string;
  message: string;
}

/**
 * REST の contents API（DELETE）で、デフォルトブランチのファイル 1 つを消すコミットを作る。
 * 失敗の扱いは updateFile と同じ。並列に呼ばないこと。
 */
export async function deleteFile(settings: Settings, deletion: FileDeletion): Promise<void> {
  const response = await sendWrite(settings, contentsUrl(settings, deletion.path), "DELETE", { message: deletion.message, sha: deletion.sha }, "unknownResult");
  if (response.ok) return;

  const responseBody = await readUpdateBody(response);
  throw new SaveError(saveErrorKindOf(response), `HTTP ${response.status}${responseBody?.message ? `: ${responseBody.message}` : ""}`);
}

/**
 * 名前を変えるファイル。content は今の本文（取得したバイト列と同じもの）、sha は取得したときの blob の sha。
 */
export interface FileRename {
  fromPath: string;
  toPath: string;
  content: string;
  sha: string;
  message: string;
}

const RENAME_CHECK_QUERY = `
query ($owner: String!, $name: String!, $from: String!, $to: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      name
      target {
        ... on Commit {
          oid
          from: file(path: $from) { oid }
          to: file(path: $to) { oid }
        }
      }
    }
  }
}`;

const RENAME_MUTATION = `
mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid }
  }
}`;

const RENAME_ATTEMPTS = 2;

interface RenameCheckResponse {
  data?: {
    repository: {
      defaultBranchRef: {
        name: string;
        target: { oid?: string; from?: { oid: string } | null; to?: { oid: string } | null } | null;
      } | null;
    } | null;
  } | null;
  errors?: GraphQLError[];
}

interface RenameMutationResponse {
  data?: { createCommitOnBranch: { commit: { oid: string } | null } | null } | null;
  errors?: GraphQLError[];
}

/**
 * GraphQL の createCommitOnBranch で、ファイルの追加（新しいパス）と削除（古いパス）を 1 コミットにまとめて名前を変える。
 * 途中で失敗しても、新旧の両方が残る・両方とも消えることは無い。
 * 先に先頭のコミットと両方のパスを確かめ、古いパスの blob が sha と違えば conflict、新しいパスにファイルがあれば exists にする。
 * expectedHeadOid が食い違ったとき（その間に別の push があった）に備えて、確認からもう 1 回だけやり直す。並列に呼ばないこと。
 */
export async function renameFile(settings: Settings, rename: FileRename): Promise<void> {
  let lastDetail = "";

  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    const head = await checkRename(settings, rename);

    const body = await postWriteGraphQL<RenameMutationResponse>(settings, RENAME_MUTATION, {
      input: {
        branch: { repositoryNameWithOwner: `${settings.owner}/${settings.repo}`, branchName: head.branch },
        message: { headline: rename.message },
        expectedHeadOid: head.oid,
        fileChanges: {
          additions: [{ path: rename.toPath, contents: toBase64(rename.content) }],
          deletions: [{ path: rename.fromPath }],
        },
      },
    }, "unknownResult");

    const errors = body.errors ?? [];
    if (errors.length === 0 && body.data?.createCommitOnBranch?.commit) return;

    lastDetail = graphQLDetail(errors, "commit が無い応答");
    if (errors.some((error) => error.type === "FORBIDDEN")) throw new SaveError("forbidden", lastDetail);

    console.warn(`[numa-pocket] 名前の変更のコミットに失敗しました（${attempt + 1} 回目）: ${lastDetail}`);
  }

  throw new SaveError("unknown", lastDetail);
}

async function checkRename(settings: Settings, rename: FileRename): Promise<{ branch: string; oid: string }> {
  const body = await postWriteGraphQL<RenameCheckResponse>(settings, RENAME_CHECK_QUERY, {
    owner: settings.owner,
    name: settings.repo,
    from: rename.fromPath,
    to: rename.toPath,
  }, "unknown");

  const errors = body.errors ?? [];
  if (errors.some((error) => error.type === "FORBIDDEN")) throw new SaveError("forbidden", graphQLDetail(errors, ""));
  if (errors.length > 0) throw new SaveError("unknown", graphQLDetail(errors, ""));

  const ref = body.data?.repository?.defaultBranchRef;
  const target = ref?.target;
  if (ref === null || ref === undefined || typeof target?.oid !== "string") {
    throw new SaveError("unknown", "デフォルトブランチの先頭を取得できませんでした");
  }

  if (target.from?.oid !== rename.sha) {
    throw new SaveError("conflict", target.from ? `${rename.fromPath} は取得した後に変わっています` : `${rename.fromPath} がありません`);
  }

  if (target.to) throw new SaveError("exists", `${rename.toPath} が既にあります`);

  return { branch: ref.name, oid: target.oid };
}

async function postWriteGraphQL<T>(settings: Settings, query: string, variables: Record<string, unknown>, transportKind: SaveErrorKind): Promise<T> {
  const response = await sendWrite(settings, GRAPHQL_ENDPOINT, "POST", { query, variables }, transportKind);

  let body: T;
  try {
    body = (await response.json()) as T;
  } catch (error) {
    throw new SaveError(response.ok ? "unknown" : saveErrorKindOf(response), `HTTP ${response.status}: JSON として読めない応答 (${String(error)})`);
  }

  if (!response.ok) {
    const message = (body as { message?: string } | null)?.message;
    throw new SaveError(saveErrorKindOf(response), `HTTP ${response.status}${message ? `: ${message}` : ""}`);
  }

  return body;
}

function graphQLDetail(errors: GraphQLError[], fallback: string): string {
  if (errors.length === 0) return fallback;

  return errors.map((error) => `${error.type ?? "ERROR"}: ${error.message ?? "(message なし)"}`).join(" / ");
}

// 書き込み系のリクエストを送る。通信の失敗（タイムアウトを含む）は transportKind の SaveError にする。
async function sendWrite(settings: Settings, url: string, method: string, body: unknown, transportKind: SaveErrorKind): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MILLISECONDS),
      headers: {
        Authorization: `Bearer ${settings.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new SaveError(transportKind, `${TIMEOUT_MILLISECONDS / 1000} 秒以内に応答がありませんでした`);
    }

    throw new SaveError(transportKind, String(error));
  }
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
