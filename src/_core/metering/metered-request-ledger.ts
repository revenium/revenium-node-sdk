const MAX_TRACKED_REQUESTS = 1000;

interface BoundedEntries {
  size: number;
  keys(): IterableIterator<string>;
  delete(key: string): unknown;
}

export class MeteredRequestLedger<TContext> {
  private readonly meteredRequestIds = new Set<string>();
  private readonly contextByRequestId = new Map<string, TContext>();

  constructor(private readonly maxTrackedRequests: number = MAX_TRACKED_REQUESTS) {}

  claim(requestId: string): boolean {
    if (this.meteredRequestIds.has(requestId)) return false;

    this.evictOldestWhenFull(this.meteredRequestIds);
    this.meteredRequestIds.add(requestId);
    return true;
  }

  release(requestId: string): void {
    this.meteredRequestIds.delete(requestId);
  }

  rememberContext(requestId: string, context: TContext): void {
    this.evictOldestWhenFull(this.contextByRequestId);
    this.contextByRequestId.set(requestId, context);
  }

  contextFor(requestId: string): TContext | undefined {
    return this.contextByRequestId.get(requestId);
  }

  forgetContext(requestId: string): void {
    this.contextByRequestId.delete(requestId);
  }

  private evictOldestWhenFull(entries: BoundedEntries): void {
    if (entries.size < this.maxTrackedRequests) return;

    const oldestRequestId = entries.keys().next().value;
    if (oldestRequestId) entries.delete(oldestRequestId);
  }
}
