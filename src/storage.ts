import * as github from "./github";
import type { Workspace } from "./workspaces";

/** 選択したワークスペースのタスクを取得する。 */
export async function fetchFolderEntries(settings: Workspace, signal: AbortSignal): Promise<github.FolderEntry[]> {
  if (settings.kind === "github") return github.fetchFolderEntries(settings, signal);

  return localRequest(settings, "list", {}, signal) as Promise<github.FolderEntry[]>;
}

/** 選択したワークスペースにタスクを追加・保存する。 */
export async function updateFile(settings: Workspace, update: github.FileUpdate): Promise<{ sha: string }> {
  if (settings.kind === "github") return github.updateFile(settings, update);

  return localRequest(settings, "write", { name: fileName(update.path), content: update.content, sha: update.sha }) as Promise<{ sha: string }>;
}

/** 選択したワークスペースのタスクを削除する。 */
export async function deleteFile(settings: Workspace, deletion: github.FileDeletion): Promise<void> {
  if (settings.kind === "github") return github.deleteFile(settings, deletion);

  await localRequest(settings, "delete", { name: fileName(deletion.path), sha: deletion.sha });
}

/** 選択したワークスペースのタスク名を変える。 */
export async function renameFile(settings: Workspace, rename: github.FileRename): Promise<void> {
  if (settings.kind === "github") return github.renameFile(settings, rename);

  await localRequest(settings, "rename", { name: fileName(rename.fromPath), to: fileName(rename.toPath), sha: rename.sha });
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

async function localRequest(settings: Workspace, action: string, data: object, signal?: AbortSignal): Promise<unknown> {
  const reading = action === "list";
  const fail = (kind: github.SaveErrorKind, detail: string): Error => reading
    ? new github.FetchError("unknown", detail)
    : new github.SaveError(kind, detail);

  try {
    const response = await fetch(`${import.meta.env.BASE_URL}api/local`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Numa-Local": "1" },
      body: JSON.stringify({ action, folder: settings.folder, ...data }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (response.status === 404) throw fail("unknown", "ローカルフォルダは npm run local で起動したアプリから利用してください");

    const result = await response.json();
    if (!response.ok) throw fail(result.kind ?? "unknown", result.detail ?? "ローカルフォルダの操作に失敗しました");

    return result;
  } catch (error) {
    if (signal?.aborted || error instanceof github.FetchError || error instanceof github.SaveError) throw error;

    throw fail(reading ? "unknown" : "unknownResult", "ローカルサーバーとの通信に失敗しました。起動状態を確認して更新してください");
  }
}
