/**
 * 積まれた順に 1 件ずつ処理する口。
 */
export interface SaveQueue<T> {
  push(job: T): void;
}

/**
 * ジョブを積まれた順に 1 件ずつ worker に渡すキューを作る。前のジョブの worker が終わるまで次を始めない。
 * worker は失敗を自分で扱う前提。それでも投げられた例外は console.error に出し、次のジョブに進む。
 */
export function createSaveQueue<T>(worker: (job: T) => Promise<void>): SaveQueue<T> {
  let tail: Promise<void> = Promise.resolve();

  return {
    push(job) {
      tail = tail.then(async () => {
        try {
          await worker(job);
        } catch (error) {
          console.error("[numa-pocket] 保存の処理で想定外のエラーが起きました", error);
        }
      });
    },
  };
}
