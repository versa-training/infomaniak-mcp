export interface DraftEntry {
    /** Full draft payload as sent to the API (HTML body, recipient objects). */
    payload: any;
    /** Mailbox that owns the draft. */
    mailboxUuid: string;
    /**
     * The text this entry reports. `local: false` marks a body read back from the
     * API (another party could have edited it); recipients always come from the API.
     */
    plain: { body?: string; to?: unknown; cc?: unknown; bcc?: unknown; local?: boolean };
    /** Quoted original of a reply or forward made by this process, re-added when the body changes. */
    quote?: string;
}

/**
 * Bounded draft cache: least recently used entries go first when it is full,
 * and entries older than the TTL are dropped on access. The API is the source
 * of truth. The cache keeps the text and quote this process wrote, and is the
 * fallback for a draft update when the load fails with a transient error (a
 * send never uses it that way).
 */
export class DraftCache {
    private readonly entries = new Map<string, { entry: DraftEntry; storedAt: number }>();

    constructor(
        private readonly maxEntries = 100,
        private readonly ttlMs = 60 * 60 * 1000,
        private readonly now: () => number = Date.now,
    ) {}

    get(draftUuid: string): DraftEntry | undefined {
        const hit = this.entries.get(draftUuid);
        if (!hit) return undefined;
        if (this.now() - hit.storedAt > this.ttlMs) {
            this.entries.delete(draftUuid);
            return undefined;
        }
        // Re-insert to mark as most recently used
        this.entries.delete(draftUuid);
        this.entries.set(draftUuid, hit);
        return hit.entry;
    }

    set(draftUuid: string, entry: DraftEntry): void {
        this.entries.delete(draftUuid);
        this.entries.set(draftUuid, {entry, storedAt: this.now()});
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    delete(draftUuid: string): void {
        this.entries.delete(draftUuid);
    }

    get size(): number {
        return this.entries.size;
    }
}
