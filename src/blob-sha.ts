/**
 * 本文を UTF-8 にしたバイト列から、git の blob の sha（`"blob <バイト数>\0" + バイト列` の SHA-1 の 16 進）を計算する。
 * GraphQL が返した本文がファイルのバイト列をそのまま表しているか（書き戻してもファイルが壊れないか）を、oid と比べて確かめるのに使う。
 */
export async function gitBlobSha(text: string): Promise<string> {
  const content = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);

  const bytes = new Uint8Array(header.byteLength + content.byteLength);
  bytes.set(header, 0);
  bytes.set(content, header.byteLength);

  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
