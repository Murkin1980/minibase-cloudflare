import { describe, it, expect, vi, afterEach } from "vitest";
import "./test-harness";
import { createHashingStream } from "./file-hash";

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function errorStream(err: Error, beforeChunks: Uint8Array[] = []): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of beforeChunks) controller.enqueue(c);
      controller.error(err);
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("createHashingStream — Workers DigestStream O(chunk)", () => {
  it("hashes empty stream to e3b0…", async () => {
    const source = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    const { stream, counter, shaPromise } = createHashingStream(source, 1024);
    const body = await new Response(stream).text();
    expect(body).toBe("");
    expect(counter.bytes).toBe(0);
    expect(counter.overflowed).toBe(false);
    await expect(shaPromise).resolves.toBe(await sha256Hex(""));
  });

  it("hashes single chunk binary correctly", async () => {
    const data = new Uint8Array([0, 255, 128, 64, 32]);
    const source = streamFromChunks([data]);
    const { stream, counter, shaPromise } = createHashingStream(source, 1024);
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(out).toEqual(data);
    expect(counter.bytes).toBe(data.byteLength);
    await expect(shaPromise).resolves.toBe(await sha256Hex(data));
  });

  it("hashes multiple chunks concatenated", async () => {
    const a = new TextEncoder().encode("hello ");
    const b = new TextEncoder().encode("world");
    const c = new TextEncoder().encode("!");
    const source = streamFromChunks([a, b, c]);
    const { stream, shaPromise } = createHashingStream(source, 1024);
    const body = await new Response(stream).text();
    expect(body).toBe("hello world!");
    await expect(shaPromise).resolves.toBe(await sha256Hex("hello world!"));
  });

  it("detects overflow and errors stream, rejecting shaPromise", async () => {
    const data = new TextEncoder().encode("abcde"); // 5 bytes
    const source = streamFromChunks([data]);
    const { stream, counter, shaPromise } = createHashingStream(source, 3);
    await expect(new Response(stream).text()).rejects.toThrow("file_too_large");
    expect(counter.bytes).toBe(5);
    expect(counter.overflowed).toBe(true);
    await expect(shaPromise).rejects.toThrow();
  });

  it("rejects shaPromise if source errors before first chunk", async () => {
    const err = new Error("source_failed");
    const source = errorStream(err, []);
    const { stream, shaPromise } = createHashingStream(source, 1024);
    // consuming the stream should error
    await expect(new Response(stream).text()).rejects.toThrow();
    await expect(shaPromise).rejects.toThrow();
  });

  it("rejects shaPromise if source errors after several chunks", async () => {
    const err = new Error("source_mid_fail");
    const a = new TextEncoder().encode("hello ");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(a);
      },
      pull(controller) {
        controller.error(err);
      },
    });
    const { stream, shaPromise } = createHashingStream(source, 1024);
    await expect(new Response(stream).text()).rejects.toThrow();
    await expect(shaPromise).rejects.toThrow();
  });

  it("propagates DigestStream write rejection as shaPromise rejection and stream error", async () => {
    // Simulate DigestStream writer.write throwing
    const orig = (globalThis.crypto as unknown as { DigestStream: unknown })["DigestStream"];
    class FailingDigestStream extends WritableStream<Uint8Array> {
      digest: Promise<ArrayBuffer>;
      constructor(_alg: string) {
        void _alg;
        let reject!: (e: unknown) => void;
        const p = new Promise<ArrayBuffer>((_, rej) => { reject = rej; });
        super({
          write() { const e = new Error("digest_write_failed"); reject(e); throw e; },
          close() {},
          abort(reason) { reject(reason); },
        });
        this.digest = p;
      }
    }
    (globalThis.crypto as unknown as Record<string, unknown>)["DigestStream"] = FailingDigestStream as unknown as never;
    try {
      const source = streamFromChunks([new TextEncoder().encode("hello")]);
      const { stream, shaPromise } = createHashingStream(source, 1024);
      await expect(new Response(stream).text()).rejects.toThrow("digest_write_failed");
      await expect(shaPromise).rejects.toThrow();
    } finally {
      (globalThis.crypto as unknown as Record<string, unknown>)["DigestStream"] = orig as unknown as never;
    }
  });

  it("aborts DigestStream and rejects shaPromise when downstream cancels (R2 conditional 412)", async () => {
    const source = streamFromChunks([new TextEncoder().encode("hello world")]);
    const { stream, shaPromise } = createHashingStream(source, 1024);
    // Simulate R2 conditional failure by cancelling the stream early (like R2 does on 412)
    const reader = stream.getReader();
    await reader.cancel(new Error("r2_conditional_412"));
    // Even though we cancelled before consuming, shaPromise must reject (abort)
    await expect(shaPromise).rejects.toThrow();
  });
});
