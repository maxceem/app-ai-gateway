import { describe, expect, it } from "vitest";
import { readBody } from "../src/http/body.ts";

/** A request whose body arrives in the given chunks, with no Content-Length unless one is given. */
function streamed(chunks: Uint8Array[], contentLength?: string): { request: Request; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[index++];
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  const request = new Request("https://gateway.test/x", { method: "POST", body: stream, headers, duplex: "half" } as RequestInit);
  return { request, cancelled: () => cancelled };
}

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

describe("readBody", () => {
  it("reads a body of exactly the limit", async () => {
    const { request } = streamed([bytes(6), bytes(4, 2)]);
    const body = await readBody(request, 10);
    expect(body.byteLength).toBe(10);
    expect(body[9]).toBe(2);
  });

  it("refuses one byte over the limit with no Content-Length, and cancels the upload", async () => {
    const { request, cancelled } = streamed([bytes(6), bytes(5), bytes(100)]);
    await expect(readBody(request, 10)).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
    expect(cancelled()).toBe(true);
  });

  it("refuses a declared length over the limit before reading", async () => {
    const { request } = streamed([bytes(1)], "11");
    await expect(readBody(request, 10)).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
  });

  it("refuses a body longer than its Content-Length", async () => {
    const { request, cancelled } = streamed([bytes(4), bytes(4), bytes(4)], "5");
    await expect(readBody(request, 10)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(cancelled()).toBe(true);
  });

  it("keeps a body shorter than its Content-Length as it arrived", async () => {
    const { request } = streamed([bytes(3)], "8");
    expect((await readBody(request, 10)).byteLength).toBe(3);
  });

  it("reads a declared body into one buffer", async () => {
    const { request } = streamed([bytes(3, 7), bytes(2, 8)], "5");
    expect([...(await readBody(request, 10))]).toEqual([7, 7, 7, 8, 8]);
  });

  it("reads an empty or absent body as zero bytes", async () => {
    expect((await readBody(new Request("https://gateway.test/x"))).byteLength).toBe(0);
    expect((await readBody(new Request("https://gateway.test/x", { method: "POST", body: "" }))).byteLength).toBe(0);
  });
});
