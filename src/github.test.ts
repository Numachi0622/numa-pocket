import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteFile, renameFile, SaveError, toBase64, updateFile, type FileRename, type FileUpdate } from "./github";
import type { Settings } from "./settings";

const settings: Settings = { token: "test-token", owner: "owner", repo: "repo", folder: "Task/Data" };
const update: FileUpdate = {
  path: "Task/Data/牛乳 を買う.md",
  content: "---\nstatus: done\n---\n",
  sha: "ce013625030ba8dba906f756967f9e9ca394464a",
  message: "numa-pocket: 牛乳 を買う today → done",
};

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFetchSequence(responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("想定より多く fetch されました");
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index: number): { variables?: Record<string, unknown> } {
  const [, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

async function saveErrorOf(promise: Promise<unknown>): Promise<SaveError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SaveError) return error;
    throw error;
  }

  throw new Error("SaveError が投げられませんでした");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toBase64", () => {
  it("UTF-8 のバイト列を base64 にする", () => {
    expect(toBase64("hello\n")).toBe("aGVsbG8K");
    expect(toBase64("日本語")).toBe("5pel5pys6Kqe");
    expect(toBase64("﻿a\r\n")).toBe("77u/YQ0K");
  });
});

describe("updateFile", () => {
  it("PUT で message・base64 の content・sha を送り、新しい sha を返す", async () => {
    const fetchMock = stubFetch(json(200, { content: { sha: "new-sha" }, commit: { sha: "commit-sha" } }));

    expect(await updateFile(settings, update)).toEqual({ sha: "new-sha" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/repo/contents/Task/Data/%E7%89%9B%E4%B9%B3%20%E3%82%92%E8%B2%B7%E3%81%86.md");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token");
    expect(JSON.parse(init.body as string)).toEqual({
      message: update.message,
      content: toBase64(update.content),
      sha: update.sha,
    });
  });

  it("branch を送らない（デフォルトブランチに書く）", async () => {
    const fetchMock = stubFetch(json(201, { content: { sha: "new-sha" } }));

    await updateFile(settings, update);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("branch");
  });

  it("sha を省くと sha を送らない（新規作成）", async () => {
    const fetchMock = stubFetch(json(201, { content: { sha: "created-sha" } }));

    expect(await updateFile(settings, { path: update.path, content: update.content, message: "add" })).toEqual({ sha: "created-sha" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ message: "add", content: toBase64(update.content) });
  });

  it.each([
    [409, "conflict"],
    [404, "conflict"],
    [422, "conflict"],
    [401, "auth"],
    [429, "rateLimit"],
    [500, "unknown"],
  ])("HTTP %i は %s", async (status, kind) => {
    stubFetch(json(status, { message: "失敗の理由" }));

    const error = await saveErrorOf(updateFile(settings, update));

    expect(error.kind).toBe(kind);
    expect(error.detail).toBe(`HTTP ${status}: 失敗の理由`);
  });

  it("403 は x-ratelimit-remaining が 0 なら利用制限、それ以外は権限なし", async () => {
    stubFetch(json(403, { message: "rate limit" }, { "x-ratelimit-remaining": "0" }));
    expect((await saveErrorOf(updateFile(settings, update))).kind).toBe("rateLimit");

    stubFetch(json(403, { message: "Resource not accessible by personal access token" }, { "x-ratelimit-remaining": "4999" }));
    expect((await saveErrorOf(updateFile(settings, update))).kind).toBe("forbidden");
  });

  it("通信エラーは結果不明", async () => {
    stubFetch(new TypeError("Load failed"));

    expect((await saveErrorOf(updateFile(settings, update))).kind).toBe("unknownResult");
  });

  it("タイムアウトは結果不明", async () => {
    stubFetch(new DOMException("timeout", "TimeoutError"));

    const error = await saveErrorOf(updateFile(settings, update));

    expect(error.kind).toBe("unknownResult");
    expect(error.detail).toContain("15 秒");
  });

  it("失敗の本文が JSON でなくても種類は決まる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(new Response("<html>", { status: 502 }));

    const error = await saveErrorOf(updateFile(settings, update));

    expect(error.kind).toBe("unknown");
    expect(error.detail).toBe("HTTP 502");
  });

  it("成功でも content.sha が無ければ不明な失敗", async () => {
    stubFetch(json(200, {}));

    expect((await saveErrorOf(updateFile(settings, update))).kind).toBe("unknown");
  });

  it("エラーの詳細にトークンを含めない", async () => {
    stubFetch(json(401, { message: "Bad credentials" }));

    const error = await saveErrorOf(updateFile(settings, update));

    expect(error.detail).not.toContain("test-token");
    expect(error.message).not.toContain("test-token");
  });
});

describe("deleteFile", () => {
  it("DELETE で message と sha を送る", async () => {
    const fetchMock = stubFetch(json(200, { commit: { sha: "commit-sha" } }));

    await deleteFile(settings, { path: update.path, sha: "ce013625030ba8dba906f756967f9e9ca394464a", message: "numa-pocket: 牛乳 を買う を削除" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/repo/contents/Task/Data/%E7%89%9B%E4%B9%B3%20%E3%82%92%E8%B2%B7%E3%81%86.md");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ message: "numa-pocket: 牛乳 を買う を削除", sha: "ce013625030ba8dba906f756967f9e9ca394464a" });
  });

  it("409 / 404 / 422 は競合、通信エラーは結果不明", async () => {
    for (const status of [409, 404, 422]) {
      stubFetch(json(status, { message: "x" }));
      expect((await saveErrorOf(deleteFile(settings, { path: update.path, sha: "ce013625030ba8dba906f756967f9e9ca394464a", message: "m" }))).kind).toBe("conflict");
    }

    stubFetch(new TypeError("Load failed"));
    expect((await saveErrorOf(deleteFile(settings, { path: update.path, sha: "ce013625030ba8dba906f756967f9e9ca394464a", message: "m" }))).kind).toBe("unknownResult");
  });
});

describe("renameFile", () => {
  const rename: FileRename = {
    fromPath: "Task/Data/牛乳 を買う.md",
    toPath: "Task/Data/豆乳 を買う.md",
    content: "---\nstatus: today\n---\n",
    sha: "old-blob",
    message: "numa-pocket: 牛乳 を買う → 豆乳 を買う (名前変更)",
  };

  function check(from: string | null, to: string | null, oid = "head-1"): Response {
    return json(200, {
      data: {
        repository: {
          defaultBranchRef: {
            name: "main",
            target: { oid, from: from === null ? null : { oid: from }, to: to === null ? null : { oid: to } },
          },
        },
      },
    });
  }

  const committed = () => json(200, { data: { createCommitOnBranch: { commit: { oid: "new-commit" } } } });
  const stale = () => json(200, { data: { createCommitOnBranch: null }, errors: [{ type: "STALE_DATA", message: "Expected branch to point to head-1" }] });

  it("先頭のコミットを確かめてから、追加と削除を 1 コミットで送る", async () => {
    const fetchMock = stubFetchSequence([check("old-blob", null), committed()]);

    await renameFile(settings, rename);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 0).variables).toEqual({ owner: "owner", name: "repo", from: rename.fromPath, to: rename.toPath });
    expect(requestBody(fetchMock, 1).variables).toEqual({
      input: {
        branch: { repositoryNameWithOwner: "owner/repo", branchName: "main" },
        message: { headline: rename.message },
        expectedHeadOid: "head-1",
        fileChanges: {
          additions: [{ path: rename.toPath, contents: toBase64(rename.content) }],
          deletions: [{ path: rename.fromPath }],
        },
      },
    });
  });

  it("古いパスの blob が違う・無ければ競合で、コミットしない", async () => {
    const changed = stubFetchSequence([check("other-blob", null)]);
    expect((await saveErrorOf(renameFile(settings, rename))).kind).toBe("conflict");
    expect(changed).toHaveBeenCalledTimes(1);

    stubFetchSequence([check(null, null)]);
    expect((await saveErrorOf(renameFile(settings, rename))).kind).toBe("conflict");
  });

  it("新しいパスにファイルがあれば exists で、コミットしない", async () => {
    const fetchMock = stubFetchSequence([check("old-blob", "someone-else")]);

    expect((await saveErrorOf(renameFile(settings, rename))).kind).toBe("exists");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("コミットがエラーを返したら、確認からもう 1 回だけやり直す", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const retried = stubFetchSequence([check("old-blob", null, "head-1"), stale(), check("old-blob", null, "head-2"), committed()]);
    await renameFile(settings, rename);
    expect((requestBody(retried, 3).variables?.input as { expectedHeadOid: string }).expectedHeadOid).toBe("head-2");

    stubFetchSequence([check("old-blob", null), stale(), check("old-blob", null), stale()]);
    const error = await saveErrorOf(renameFile(settings, rename));
    expect(error.kind).toBe("unknown");
    expect(error.detail).toContain("STALE_DATA");
  });

  it("FORBIDDEN は権限なしで、やり直さない", async () => {
    const forbidden = json(200, { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }] });
    const fetchMock = stubFetchSequence([check("old-blob", null), forbidden]);

    expect((await saveErrorOf(renameFile(settings, rename))).kind).toBe("forbidden");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("コミットの通信エラーは結果不明、確認の通信エラーは不明な失敗", async () => {
    const responses: (Response | Error)[] = [check("old-blob", null), new TypeError("Load failed")];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const next = responses.shift();
      if (next === undefined || next instanceof Error) throw next ?? new Error("想定より多く fetch されました");
      return next;
    }));
    expect((await saveErrorOf(renameFile(settings, rename))).kind).toBe("unknownResult");

    stubFetch(new TypeError("Load failed"));
    expect((await saveErrorOf(renameFile(settings, rename))).kind).toBe("unknown");
  });
});
