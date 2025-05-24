/**
 * Adaptive buffer that coalesces small text chunks into larger ones.
 *
 *  • Starts with an initial threshold (default 10 chars)
 *  • After each flush, grows by `step` up to `max`
 *  • `add(chunk)` returns <string|null> – the string you should emit when it’s time
 *  • `flush()` forces out whatever’s left
 */
export class DeltaBuffer {
    private buffer = '';
    private startTimestamp: number | null = null;
    private threshold: number;

    constructor(
        private readonly step = 20,
        private readonly max = 400,
        initial = 20,
        private readonly timeLimitMs = 10_000 // flush after 20 s of inactivity
    ) {
        this.threshold = initial;
    }

    add(chunk: string): string | null {
        this.buffer += chunk;

        // set start time on first chunk added
        if (this.startTimestamp === null) this.startTimestamp = Date.now();

        const shouldFlushBySize = this.buffer.length >= this.threshold;
        const shouldFlushByTime =
            this.startTimestamp !== null &&
            Date.now() - this.startTimestamp >= this.timeLimitMs;

        if (shouldFlushBySize || shouldFlushByTime) {
            const out = this.buffer;
            this.buffer = '';
            this.startTimestamp = null;
            if (shouldFlushBySize && this.threshold < this.max) {
                // Only grow the threshold on size‑triggered flushes
                this.threshold += this.step;
            }
            return out;
        }
        return null;
    }

    flush(): string | null {
        if (!this.buffer) return null;
        const out = this.buffer;
        this.buffer = '';
        this.startTimestamp = null;
        return out;
    }
}

/**
 * Convenience: buffer a chunk and – if ready – return event objects via `makeEvent`.
 * The map guarantees one buffer per message_id.
 */
export function bufferDelta<T>(
    store: Map<string, DeltaBuffer>,
    messageId: string,
    chunk: string,
    makeEvent: (content: string) => T
): T[] {
    let buf = store.get(messageId);
    if (!buf) {
        buf = new DeltaBuffer();
        store.set(messageId, buf);
    }
    const out = buf.add(chunk);
    return out !== null ? [makeEvent(out)] : [];
}

/**
 * Flush all remaining buffers and return events via `makeEvent`.
 * Clears the store afterwards.
 */
export function flushBufferedDeltas<T>(
    store: Map<string, DeltaBuffer>,
    makeEvent: (id: string, content: string) => T
): T[] {
    const events: T[] = [];
    for (const [id, buf] of store) {
        const out = buf.flush();
        if (out !== null) events.push(makeEvent(id, out));
    }
    store.clear();
    return events;
}
