import { describe, expect, it } from "vitest";
declare const process: { on: (e: string, h: (r: unknown) => void) => void; off: (e: string, h: (r: unknown) => void) => void };
import "./test-harness";
import { createHashingStream } from "./file-hash";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("hashing Promise lifecycle — unhandledRejection", () => {
  it("no unhandledRejection when source errors and shaPromise is marked", async () => {
    const unhandled: unknown[] = [];
    const handler = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", handler);
    try {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("source_failed"));
        },
      });
      const { stream, shaPromise } = createHashingStream(source, 1024);
      void shaPromise.catch(() => {}); // single owner mark as API does
      const reader = stream.getReader();
      await expect(reader.read()).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      await expect(shaPromise).rejects.toThrow();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("no unhandledRejection when downstream cancels (R2 412) and shaPromise is marked", async () => {
    const unhandled: unknown[] = [];
    const handler = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", handler);
    try {
      const source = streamFromText("hello");
      const { stream, shaPromise } = createHashingStream(source, 1024);
      void shaPromise.catch(() => {});
      const reader = stream.getReader();
      // Simulate R2 conditional 412 by cancelling downstream
      await reader.cancel(new Error("r2_412"));
      await new Promise((r) => setTimeout(r, 10));
      await expect(shaPromise).rejects.toThrow();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("no unhandledRejection for digest write failure", async () => {
    const unhandled: unknown[] = [];
    const handler = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", handler);
    const orig = (globalThis.crypto as unknown as Record<string, unknown>)["DigestStream"];
    class FailingDigest extends WritableStream<Uint8Array> {
      digest: Promise<ArrayBuffer>;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(_alg: string) {
        let reject!: (e: unknown) => void;
        const p = new Promise<ArrayBuffer>((_, rej) => { reject = rej; });
        super({
          write() {
            const e = new Error("digest_write_failed");
            reject(e);
            throw e;
          },
        });
        this.digest = p;
      }
    }
    (globalThis.crypto as unknown as Record<string, unknown>)["DigestStream"] = FailingDigest as unknown as never;
    try {
      const source = streamFromText("hello");
      const { stream, shaPromise } = createHashingStream(source, 1024);
      void shaPromise.catch(() => {});
      const reader = stream.getReader();
      await expect(reader.read()).rejects.toThrow("digest_write_failed");
      await new Promise((r) => setTimeout(r, 10));
      await expect(shaPromise).rejects.toThrow();
      expect(unhandled).toHaveLength(0);
    } finally {
      (globalThis.crypto as unknown as Record<string, unknown>)["DigestStream"] = orig as unknown as never;
      process.off("unhandledRejection", handler);
    }
  });

  it("single owner: digest rejection has exactly one handler", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(c) { c.error(new Error("fail")); },
    });
    const { shaPromise } = createHashingStream(source, 1024);
    let secondRejected = false;
    const second = shaPromise.catch(() => { secondRejected = true; });
    await new Promise((r) => setTimeout(r, 10));
    await expect(shaPromise).rejects.toThrow();
    await expect(second).resolves.toBeUndefined();
    expect(secondRejected).toBe(true);
  });
});
