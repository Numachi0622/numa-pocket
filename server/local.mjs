import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat, lstat, link, unlink, rename, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const BASE = "/numa-pocket/";
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const MAX_BODY_BYTES = 8 * 1024 * 1024;

class LocalError extends Error {
  constructor(kind, detail) {
    super(detail);
    this.kind = kind;
  }
}

function sha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function taskPath(folder, name) {
  if (typeof name !== "string" || !name.endsWith(".md") || /[\\/\x00-\x1f]/.test(name) || basename(name) !== name) {
    throw new LocalError("unknown", "タスクのファイル名が不正です");
  }

  return join(folder, name);
}

async function readTask(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new LocalError("unknown", "通常のファイルだけを読み書きできます");

  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function checkVersion(path, expected) {
  if (typeof expected !== "string" || !expected) throw new LocalError("unknown", "取得時のファイル情報がありません");

  const bytes = await readTask(path);
  if (sha(bytes) !== expected) throw new LocalError("conflict", "取得後にファイルが変更されています");

  return bytes;
}

async function assertDestinationFree(folder, name) {
  const names = await readdir(folder);
  const normalize = (value) => value.normalize("NFC").toLowerCase();
  if (names.some((entry) => normalize(entry) === normalize(name))) {
    throw new LocalError("exists", "同じ名前のファイルが既にあります");
  }
}

/** 指定フォルダ直下のタスクだけを読み書きする。呼び出し側で操作を直列化する。 */
export async function operateLocal(request) {
  if (typeof request.folder !== "string" || !request.folder.trim()) throw new LocalError("unknown", "フォルダを指定してください");

  const expanded = request.folder.startsWith("~/") ? join(homedir(), request.folder.slice(2)) : request.folder;
  if (!isAbsolute(expanded)) throw new LocalError("unknown", "フォルダは絶対パスで指定してください");

  const folder = await realpath(expanded);
  if (!(await stat(folder)).isDirectory()) throw new LocalError("unknown", "指定先はフォルダではありません");

  if (request.action === "list") {
    const entries = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      try {
        const bytes = await readTask(join(folder, entry.name));
        entries.push({ name: entry.name, type: "blob", oid: sha(bytes), text: bytes.toString("utf8") });
      } catch (error) {
        if (error.code === "ENOENT") continue;

        throw error;
      }
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  const path = taskPath(folder, request.name);
  if (request.action === "write") {
    if (typeof request.content !== "string") throw new LocalError("unknown", "保存する本文が不正です");

    const bytes = Buffer.from(request.content, "utf8");
    if (request.sha === undefined) {
      await assertDestinationFree(folder, request.name);
      await writeExclusive(path, bytes);
    } else {
      await checkVersion(path, request.sha);
      const temporary = join(folder, `.numa-pocket-${randomUUID()}.tmp`);
      try {
        const mode = (await stat(path)).mode;
        await writeExclusive(temporary, bytes, mode);
        await checkVersion(path, request.sha);
        await rename(temporary, path);
      } finally {
        try {
          await unlink(temporary);
        } catch (error) {
          if (error.code !== "ENOENT") console.error("[numa-pocket] 一時ファイルを片付けられませんでした", error);
        }
      }
    }

    return { sha: sha(bytes) };
  }

  if (request.action === "delete") {
    await checkVersion(path, request.sha);
    await unlink(path);
    return {};
  }

  if (request.action === "rename") {
    const destination = taskPath(folder, request.to);
    await checkVersion(path, request.sha);
    await assertDestinationFree(folder, request.to);
    await link(path, destination);
    try {
      await checkVersion(path, request.sha);
    } catch (error) {
      await unlink(destination);
      throw error;
    }

    try {
      await unlink(path);
    } catch (error) {
      console.error("[numa-pocket] 名前変更後に元ファイルを外せませんでした", error);
      throw new LocalError("unknownResult", "元ファイルと新しい名前のファイルが残っている可能性があります。更新して確認してください");
    }
    return {};
  }

  throw new LocalError("unknown", "操作の種類が不正です");
}

async function writeExclusive(path, bytes, mode) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new LocalError("unknown", "リクエストが大きすぎます（上限 8 MiB）");

    chunks.push(chunk);
  }

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("object required");

    return value;
  } catch {
    throw new LocalError("unknown", "JSON の形式が不正です");
  }
}

/** ループバック専用のアプリ配信・ローカルファイル API サーバーを作る。 */
export function createLocalServer() {
  let tail = Promise.resolve();
  return createServer(async (request, response) => {
    const port = response.socket.localPort;
    const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    const host = request.headers.host;
    if (!allowedHosts.includes(host)) {
      json(response, 403, { detail: "localhost からアクセスしてください" });
      return;
    }

    const url = new URL(request.url, `http://${host}`);
    if (url.pathname === `${BASE}api/local`) {
      if (request.method !== "POST" || request.headers.origin !== `http://${host}` || request.headers["x-numa-local"] !== "1" || !request.headers["content-type"]?.startsWith("application/json")) {
        json(response, 403, { detail: "このアプリからの操作だけを受け付けます" });
        return;
      }

      try {
        const body = await readBody(request);
        const operation = tail.then(() => operateLocal(body));
        // 失敗は下の catch で応答・記録し、次の操作が実行できるようキューだけを復旧する。
        tail = operation.catch(() => undefined);
        const result = await operation;
        json(response, 200, result);
      } catch (error) {
        const kind = error instanceof LocalError ? error.kind
          : error.code === "EEXIST" ? "exists"
          : error.code === "ENOENT" && request.method === "POST" ? "conflict"
          : error.code === "EACCES" || error.code === "EPERM" ? "forbidden" : "unknown";
        const detail = error instanceof LocalError ? error.message
          : error.code === "ENOENT" ? "フォルダまたはファイルが見つかりません。パスを確認してください"
          : kind === "forbidden" ? "フォルダまたはファイルへのアクセス権限がありません"
          : kind === "exists" ? "同じ名前のファイルが既にあります"
          : "ローカルファイルの操作に失敗しました。サーバーのログを確認してください";
        console.error("[numa-pocket] ローカル操作に失敗しました", error);
        json(response, kind === "conflict" || kind === "exists" ? 409 : 400, { kind, detail });
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    if (url.pathname === "/" || url.pathname === "/numa-pocket") {
      response.writeHead(302, { Location: BASE }).end();
      return;
    }

    try {
      const relative = decodeURIComponent(url.pathname.slice(BASE.length));
      const path = resolve(DIST, relative || "index.html");
      if (!url.pathname.startsWith(BASE) || (!path.startsWith(DIST) && path !== join(DIST, "index.html"))) {
        response.writeHead(404).end();
        return;
      }

      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
      const body = await readFile(path);
      response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EISDIR") console.error("[numa-pocket] 配信に失敗しました", error);

      response.writeHead(404).end();
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.NUMA_PORT ?? 4173);
  const server = createLocalServer();
  server.on("error", (error) => {
    console.error("[numa-pocket] ローカルサーバーを起動できませんでした", error);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.info(`numa-pocket: http://localhost:${port}${BASE}`));
}
