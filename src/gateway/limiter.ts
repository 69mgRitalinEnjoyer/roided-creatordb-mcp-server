/**
 * Decides whose turn it is to call CreatorDB.
 *
 * Each workspace has a fixed number of in-flight requests. Whole-list pulls must leave a few of
 * those free, so a question asked in chat never waits behind a 10,000-creator pull.
 */
export class Limiter {
  private readonly inFlight = new Map<string, number>();
  private readonly waiting = new Map<string, Array<{ priority: 'lookup' | 'pull'; wake: () => void }>>();

  constructor(
    private readonly maxInFlight: number,
    private readonly lookupReserve: number,
  ) {}

  private limitFor(priority: 'lookup' | 'pull'): number {
    return priority === 'lookup' ? this.maxInFlight : Math.max(1, this.maxInFlight - this.lookupReserve);
  }

  async acquire(workspaceId: string, priority: 'lookup' | 'pull'): Promise<() => void> {
    while ((this.inFlight.get(workspaceId) ?? 0) >= this.limitFor(priority)) {
      await new Promise<void>((wake) => {
        const queue = this.waiting.get(workspaceId) ?? [];
        const entry = { priority, wake };
        // Lookups join ahead of every waiting pull.
        if (priority === 'lookup') {
          const firstPull = queue.findIndex((w) => w.priority === 'pull');
          queue.splice(firstPull === -1 ? queue.length : firstPull, 0, entry);
        } else {
          queue.push(entry);
        }
        this.waiting.set(workspaceId, queue);
      });
    }
    this.inFlight.set(workspaceId, (this.inFlight.get(workspaceId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.inFlight.get(workspaceId) ?? 1) - 1;
      if (left <= 0) this.inFlight.delete(workspaceId);
      else this.inFlight.set(workspaceId, left);
      const queue = this.waiting.get(workspaceId);
      if (!queue?.length) return;
      // Wake everyone; each waiter re-checks its own limit and goes back to sleep if it must.
      this.waiting.delete(workspaceId);
      for (const waiter of queue) waiter.wake();
    };
  }
}
