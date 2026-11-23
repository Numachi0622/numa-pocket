import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operateLocal, createLocalServer } from "./local.mjs";

const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "numa-pocket-test-"));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const content = "---\r\nstatus: today\r\n---\r\n本文\r\n";
  await writeFile(join(folder, "仕事.md"), content);
  const entries = await operateLocal({ action: "list", folder });
  return { folder, content, sha: entries[0].oid };
}

describe("ローカルフォルダ", () => {
  it("直下の md だけを読み、BOM と改行を保つ", async () => {
    const { folder, content } = await fixture();
    await writeFile(join(folder, "bom.md"), `\uFEFF${content}`);
    await writeFile(join(folder, "memo.txt"), "ignore");
    await mkdir(join(folder, "sub"));
    await writeFile(join(folder, "sub", "nested.md"), content);
    await symlink(join(folder, "仕事.md"), join(folder, "link.md"));
    const entries = await operateLocal({ action: "list", folder });
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.name === "bom.md").text).toBe(`\uFEFF${content}`);
  });

  it("追加・更新・名前変更・削除で指定したファイルだけを変える", async () => {
    const { folder, sha, content } = await fixture();
    await operateLocal({ action: "write", folder, name: "新規.md", content });
    const changed = content.replace("today", "done");
    const updated = await operateLocal({ action: "write", folder, name: "仕事.md", sha, content: changed });
    await operateLocal({ action: "rename", folder, name: "仕事.md", to: "完了.md", sha: updated.sha });
    expect(await readFile(join(folder, "完了.md"), "utf8")).toBe(changed);
    await expect(readFile(join(folder, "仕事.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await operateLocal({ action: "delete", folder, name: "完了.md", sha: updated.sha });
    expect((await operateLocal({ action: "list", folder })).map((entry) => entry.name)).toEqual(["新規.md"]);
    expect(await readFile(join(folder, "新規.md"), "utf8")).toBe(content);
  });

  it.each(["write", "rename", "delete"])("外部で変わったファイルは %s しない", async (action) => {
    const { folder, sha } = await fixture();
    await writeFile(join(folder, "仕事.md"), "外部からの変更");
    await expect(operateLocal({ action, folder, name: "仕事.md", sha, content: "overwrite", to: "変更.md" })).rejects.toMatchObject({ kind: "conflict" });
    expect(await readFile(join(folder, "仕事.md"), "utf8")).toBe("外部からの変更");
  });

  it("追加と名前変更は同名のファイルを上書きしない", async () => {
    const { folder, sha, content } = await fixture();
    await writeFile(join(folder, "existing.md"), "keep");
    await expect(operateLocal({ action: "write", folder, name: "EXISTING.md", content })).rejects.toMatchObject({ kind: "exists" });
    await expect(operateLocal({ action: "rename", folder, name: "仕事.md", sha, to: "existing.md" })).rejects.toMatchObject({ kind: "exists" });
    expect(await readFile(join(folder, "existing.md"), "utf8")).toBe("keep");
    expect(await readFile(join(folder, "仕事.md"), "utf8")).toBe(content);
  });

  it("フォルダ外の名前と symlink への書き込みを拒否する", async () => {
    const { folder, sha, content } = await fixture();
    await expect(operateLocal({ action: "write", folder, name: "../outside.md", content })).rejects.toMatchObject({ kind: "unknown" });
    await symlink(join(folder, "仕事.md"), join(folder, "link.md"));
    await expect(operateLocal({ action: "write", folder, name: "link.md", sha, content: "overwrite" })).rejects.toMatchObject({ kind: "unknown" });
    expect(await readFile(join(folder, "仕事.md"), "utf8")).toBe(content);
  });

  it("同名のファイルを持つ複数フォルダの操作が混ざらない", async () => {
    const first = await fixture();
    const second = await fixture();
    await operateLocal({ action: "write", folder: first.folder, name: "仕事.md", sha: first.sha, content: "first" });
    expect(await readFile(join(second.folder, "仕事.md"), "utf8")).toBe(second.content);
  });
});

describe("ローカル HTTP API", () => {
  async function start() {
    const server = createLocalServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Numa-Local": "1" };
    return { origin, headers, url: `${origin}/numa-pocket/api/local` };
  }

  it("同一オリジンのアプリだけがフォルダを読める", async () => {
    const { folder } = await fixture();
    const { origin, headers, url } = await start();
    const body = JSON.stringify({ action: "list", folder });
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(200);
    expect((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://example.com" }, body })).status).toBe(403);
    const invalidHostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(url, { method: "POST", headers: { ...headers, Host: "attacker.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end(body);
    });
    expect(invalidHostStatus).toBe(403);
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(`${origin}/` , { redirect: "manual" })).status).toBe(302);
  });

  it("並列の新規作成は1件だけ成功し、既存内容を保護する", async () => {
    const { folder } = await fixture();
    const { headers, url } = await start();
    const responses = await Promise.all(["one", "two"].map((content) => fetch(url, {
      method: "POST", headers, body: JSON.stringify({ action: "write", folder, name: "new.md", content }),
    })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(["one", "two"]).toContain(await readFile(join(folder, "new.md"), "utf8"));
  });
});
