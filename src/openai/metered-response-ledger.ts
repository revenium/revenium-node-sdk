import type { UsageMetadata } from "../_core/types/index.js";

const MAX_TRACKED_RESPONSES = 1000;

export interface PendingResponseContext {
  metadata?: UsageMetadata;
  messages?: unknown[];
}

interface BoundedEntries {
  size: number;
  keys(): IterableIterator<string>;
  delete(key: string): unknown;
}

export class MeteredResponseLedger {
  private readonly meteredResponseIds = new Set<string>();
  private readonly contextByResponseId = new Map<string, PendingResponseContext>();

  constructor(private readonly maxTrackedResponses: number = MAX_TRACKED_RESPONSES) {}

  claim(responseId: string): boolean {
    if (this.meteredResponseIds.has(responseId)) return false;

    this.evictOldestWhenFull(this.meteredResponseIds);
    this.meteredResponseIds.add(responseId);
    return true;
  }

  release(responseId: string): void {
    this.meteredResponseIds.delete(responseId);
  }

  rememberContext(responseId: string, context: PendingResponseContext): void {
    this.evictOldestWhenFull(this.contextByResponseId);
    this.contextByResponseId.set(responseId, context);
  }

  contextFor(responseId: string): PendingResponseContext | undefined {
    return this.contextByResponseId.get(responseId);
  }

  private evictOldestWhenFull(entries: BoundedEntries): void {
    if (entries.size < this.maxTrackedResponses) return;

    const oldestResponseId = entries.keys().next().value;
    if (oldestResponseId) entries.delete(oldestResponseId);
  }
}
