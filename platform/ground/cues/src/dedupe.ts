/* ============================================================================
 * eis-cues — bounded id memory.
 *
 * The same cue must never be emitted twice, but a ground station runs for days:
 * an unbounded "seen" set is a slow leak. This remembers the most recent ids
 * and forgets the oldest, which is the right trade — a duplicate that arrives
 * thousands of cues later is, by any operational definition, a new cue.
 * ========================================================================== */

export const DEFAULT_ID_MEMORY = 1024;

export class BoundedIdSet {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number = DEFAULT_ID_MEMORY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('BoundedIdSet capacity must be a positive integer');
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Record `id`. Returns false when it was already remembered. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.order.push(id);
    while (this.order.length > this.capacity) {
      this.ids.delete(this.order.shift() as string);
    }
    return true;
  }

  get size(): number {
    return this.ids.size;
  }
}
