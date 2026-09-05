/**
 * Streaming SHA-256 helper for Workers.
 *
 * Production path only: uses workerd `crypto.DigestStream("SHA-256")` which is
 * O(chunk) memory and never buffers the whole file. No Node fallback or
 * buffering fallback is included in the Worker bundle — that keeps the bundle
 * minimal and proves O(chunk) in production.
 *
 * Test environments that lack DigestStream (Node vitest) must polyfill it via
 * `src/test-harness` before importing this module.
 *
 * Returned `stream` must be piped to R2; `counter` counts measured bytes;
 * `shaPromise` resolves to lowercase 64-char hex after the stream is fully
 * consumed, or rejects if the source errors, a write fails, or the downstream
 * cancels (e.g., R2 conditional 412). On any error the DigestStream writer is
 * aborted so `shaPromise` never hangs and no unhandled rejection leaks.
 *
 * Cancellation is handled via explicit ReadableStream lifecycle (pull/cancel),
 * not via TransformStream's non-standard cancel callback.
 */

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface HashingCounter {
  bytes: number;
  overflowed: boolean;
}

interface HashingResult {
  stream: ReadableStream<Uint8Array>;
  counter: HashingCounter;
  shaPromise: Promise<string>;
}

function getDigestStreamCtor(): new (alg: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } {
  const c = crypto as unknown as Record<string, unknown>;
  const maybeCtor = c["DigestStream"] as unknown;
  if (!maybeCtor) throw new Error("DigestStream not available — polyfill required in tests");
  return maybeCtor as new (alg: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
}

export function createHashingStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): HashingResult {
  const counter: HashingCounter = { bytes: 0, overflowed: false };
  const DigestStream = getDigestStreamCtor();
  const digestStream = new DigestStream("SHA-256");
  const writer = digestStream.getWriter();
  let writerDone = false;
  let writerError: unknown = null;

  const shaPromise: Promise<string> = digestStream.digest.then(
    (buf) => toHex(buf),
    (err) => {
      throw err instanceof Error ? err : new Error(String(err));
    },
  ).catch((err) => {
    if (writerError) throw writerError;
    throw err;
  });

  const abortWriter = (reason: unknown) => {
    if (writerDone) return;
    writerDone = true;
    writerError = reason;
    const w = writer as unknown as { abort?: (r: unknown) => Promise<void>; close: () => Promise<void> };
    try {
      if (w.abort) {
        w.abort(reason).catch(() => {});
      } else {
        w.close().catch(() => {});
      }
    } catch (_e) { void _e; }
  };

  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let pullActive = false;
  let cancelled = false;
  let cancelReason: unknown = null;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) {
        controller.error(cancelReason ?? new Error("cancelled"));
        return;
      }
      if (pullActive) return;
      pullActive = true;
      try {
        if (!sourceReader) {
          try {
            sourceReader = source.getReader();
          } catch (err) {
            abortWriter(err);
            controller.error(err);
            return;
          }
        }
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await sourceReader.read();
        } catch (err) {
          abortWriter(err);
          controller.error(err);
          return;
        }
        if (readResult.done) {
          try {
            await writer.close();
            writerDone = true;
          } catch (err) {
            abortWriter(err);
            controller.error(err);
            return;
          }
          controller.close();
          return;
        }
        const chunk = readResult.value;
        counter.bytes += chunk.byteLength;
        if (counter.bytes > maxBytes) {
          counter.overflowed = true;
          const err = new Error("file_too_large");
          abortWriter(err);
          controller.error(err);
          try {
            await sourceReader.cancel(err);
          } catch (_e) { void _e; }
          return;
        }
        try {
          await writer.write(chunk);
        } catch (err) {
          abortWriter(err);
          controller.error(err);
          try {
            await sourceReader.cancel(err);
          } catch (_e) { void _e; }
          return;
        }
        if (cancelled) {
          // Check again after write, in case cancel happened during write
          controller.error(cancelReason ?? new Error("cancelled"));
          return;
        }
        controller.enqueue(chunk);
      } finally {
        pullActive = false;
      }
    },
    async cancel(reason) {
      cancelled = true;
      cancelReason = reason;
      abortWriter(reason ?? new Error("cancelled"));
      if (sourceReader) {
        try {
          await sourceReader.cancel(reason);
        } catch (_e) { void _e; }
      } else {
        // Source not yet locked, try to cancel source directly if possible
        try {
          // source may have cancel in some streams
          if (typeof (source as unknown as { cancel?: (r: unknown) => Promise<void> }).cancel === "function") {
            await (source as unknown as { cancel: (r: unknown) => Promise<void> }).cancel(reason);
          }
        } catch (_e) { void _e; }
      }
    },
  });

  return { stream, counter, shaPromise };
}
