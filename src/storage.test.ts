import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteFile, fetchFolderEntries, renameFile, updateFile } from "./storage";
import { FetchError, SaveError } from "./github";
import type { Workspace } from "./workspaces";

const settings: Workspace = { id: "work", label: "仕事", kind: "local", folder: "/work/tasks", token: "must-not-send", owner: "", repo: "" };
afterEach(() => vi.unstubAllGlobals());

describe("ローカル接続への振り分け", () => {
  it("リクエストに認証情報を含めず、対象フォルダとファイルを指定する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sha: "new" })));
    vi.stubGlobal("fetch", fetchMock);
    await updateFile(settings, { path: "/work/tasks/仕事.md", content: "text", sha: "old", message: "unused" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/api\/local$/);
    expect(JSON.parse(init.body)).toEqual({ action: "write", folder: "/work/tasks", name: "仕事.md", content: "text", sha: "old" });
    expect(JSON.stringify(init)).not.toContain(settings.token);
  });

  it("リネームと削除もローカル API を呼ぶ", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetchMock);
    await renameFile(settings, { fromPath: "/work/tasks/前.md", toPath: "/work/tasks/後.md", content: "keep", sha: "old", message: "unused" });
    await deleteFile(settings, { path: "/work/tasks/後.md", sha: "old", message: "unused" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: "rename", name: "前.md", to: "後.md" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ action: "delete", name: "後.md" });
  });

  it("競合は既存の保存失敗処理に伝える", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ kind: "conflict", detail: "changed" }), { status: 409 })));
    await expect(updateFile(settings, { path: "x.md", content: "text", sha: "old", message: "" })).rejects.toMatchObject({ kind: "conflict", detail: "changed" });
  });

  it("ローカル API がない場合は起動方法を案内する", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    await expect(fetchFolderEntries(settings, new AbortController().signal)).rejects.toBeInstanceOf(FetchError);
  });

  it("通信切断による保存の結果不明を区別する", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(deleteFile(settings, { path: "x.md", sha: "old", message: "" })).rejects.toBeInstanceOf(SaveError);
    await expect(deleteFile(settings, { path: "x.md", sha: "old", message: "" })).rejects.toMatchObject({ kind: "unknownResult" });
  });
});
