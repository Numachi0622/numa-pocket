import { afterEach, describe, expect, it, vi } from "vitest";
import { isWorkspaceComplete, loadWorkspaces, saveWorkspaces, type Workspace } from "./workspaces";

const github: Workspace = { id: "github", label: "個人", kind: "github", owner: "owner", repo: "repo", folder: "Task/Data", token: "example" };
const local: Workspace = { id: "local", label: "仕事", kind: "local", owner: "", repo: "", folder: "/tasks", token: "" };

function storage(values: Record<string, string> = {}) {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value; },
  });
  return values;
}

afterEach(() => vi.unstubAllGlobals());

describe("ワークスペース設定", () => {
  it("旧設定を GitHub ワークスペースとして引き継ぐ", () => {
    storage({ "numa-pocket:settings": JSON.stringify(github) });
    expect(loadWorkspaces()).toEqual({ workspaces: [{ ...github, id: "legacy", label: "repo" }], activeId: "legacy" });
  });

  it("複数の接続先と選択中のフォルダを保存する", () => {
    storage();
    const config = { workspaces: [github, local], activeId: "local" };
    saveWorkspaces(config);
    expect(loadWorkspaces()).toEqual(config);
  });

  it("ローカルでは GitHub の設定を要求しない", () => {
    expect(isWorkspaceComplete(local)).toBe(true);
    expect(isWorkspaceComplete({ ...local, folder: "" })).toBe(false);
    expect(isWorkspaceComplete({ ...github, token: "" })).toBe(false);
  });

  it("ID 重複や存在しない選択先は保存しない", () => {
    storage();
    expect(() => saveWorkspaces({ workspaces: [github, github], activeId: "github" })).toThrow();
    expect(() => saveWorkspaces({ workspaces: [local], activeId: "missing" })).toThrow();
  });
});
