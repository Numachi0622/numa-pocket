import { isComplete, loadSettings, type Settings } from "./settings";

const STORAGE_KEY = "numa-pocket:workspaces";

/** 名前を付けて切り替えるタスクフォルダ。 */
export interface Workspace extends Settings {
  id: string;
  label: string;
  kind: "github" | "local";
}

/** 登録したフォルダと、最後に開いたフォルダ。 */
export interface WorkspaceSettings {
  workspaces: Workspace[];
  activeId: string;
}

/** 接続方法に必要な設定が揃っているかを返す。 */
export function isWorkspaceComplete(workspace: Workspace): boolean {
  return workspace.label.trim().length > 0 && (workspace.kind === "local" ? workspace.folder.trim().length > 0 : isComplete(workspace));
}

/** 旧形式の設定は最初の GitHub ワークスペースとして読み込む。 */
export function loadWorkspaces(): WorkspaceSettings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) {
    try {
      const value: unknown = JSON.parse(raw);
      if (!isWorkspaceSettings(value)) throw new Error("ワークスペース設定の形式が不正です");

      return value;
    } catch (error) {
      console.error("[numa-pocket] ワークスペース設定を読めませんでした", error);
      return { workspaces: [], activeId: "" };
    }
  }

  const legacy = loadSettings();
  if (legacy === null) return { workspaces: [], activeId: "" };

  const workspace: Workspace = { ...legacy, id: "legacy", label: legacy.repo || "GitHub", kind: "github" };
  return { workspaces: [workspace], activeId: workspace.id };
}

/** ワークスペースと選択状態をまとめて保存する。 */
export function saveWorkspaces(settings: WorkspaceSettings): void {
  if (!isWorkspaceSettings(settings)) throw new Error("ワークスペース設定の形式が不正です");

  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function isWorkspaceSettings(value: unknown): value is WorkspaceSettings {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.workspaces) || typeof record.activeId !== "string") return false;

  const ids = new Set<string>();
  for (const workspace of record.workspaces) {
    if (typeof workspace !== "object" || workspace === null) return false;
    if (!["id", "label", "folder", "token", "owner", "repo"].every((key) => typeof workspace[key] === "string")) return false;
    if (workspace.kind !== "github" && workspace.kind !== "local") return false;
    if (!workspace.id || ids.has(workspace.id)) return false;

    ids.add(workspace.id);
  }

  return record.workspaces.length === 0 ? record.activeId === "" : ids.has(record.activeId);
}
