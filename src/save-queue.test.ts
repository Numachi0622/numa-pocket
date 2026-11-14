import { describe, expect, it, vi } from "vitest";
import { createSaveQueue } from "./save-queue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createSaveQueue", () => {
  it("前のジョブが終わるまで次を始めない", async () => {
    const log: string[] = [];
    const first = deferred();
    const queue = createSaveQueue<string>(async (job) => {
      log.push(`start ${job}`);
      if (job === "a") {
        await first.promise;
      }
      log.push(`end ${job}`);
    });

    queue.push("a");
    queue.push("b");
    await vi.waitFor(() => expect(log).toEqual(["start a"]));

    first.resolve();
    await vi.waitFor(() => expect(log).toEqual(["start a", "end a", "start b", "end b"]));
  });

  it("worker が例外を投げても次のジョブに進む", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const done: string[] = [];
    const queue = createSaveQueue<string>(async (job) => {
      if (job === "a") throw new Error("失敗");
      done.push(job);
    });

    queue.push("a");
    queue.push("b");

    await vi.waitFor(() => expect(done).toEqual(["b"]));
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
