/** A shared budget across regions: at most three candidates, at most two backups. */
export class PriorityProbeBudget {
  private active = 0;
  private backups = 0;
  private queue: { lane: "active" | "backup"; valid(): boolean; run(): void; cancel(): void }[] = [];
  run<T>(lane: "active" | "backup", valid: () => boolean, work: () => Promise<T>): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.queue.push({ lane, valid, cancel: () => resolve(undefined), run: () => {
        this.active++; if (lane === "backup") this.backups++;
        void Promise.resolve().then(work).then(resolve, reject).finally(() => { this.active--; if (lane === "backup") this.backups--; this.drain(); });
      } });
      this.drain();
    });
  }
  private drain(): void {
    this.queue = this.queue.filter(item => { if (item.valid()) return true; item.cancel(); return false; });
    while (this.active < 3) {
      let index = this.queue.findIndex(item => item.lane === "active");
      if (index < 0 && this.backups < 2) index = this.queue.findIndex(item => item.lane === "backup");
      if (index < 0) return;
      this.queue.splice(index, 1)[0].run();
    }
  }
}
