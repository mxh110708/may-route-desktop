/** Timer and UI readers must await the same restoration, not observe its halfway state. */
export class PriorityRuntimeRestore {
  private pending: Promise<void> | null = null;

  run(check: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    const pending = Promise.resolve().then(check).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
}
