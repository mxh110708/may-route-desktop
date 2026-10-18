/** Pauses application observers without stopping or reconfiguring the proxy. */
export class BackgroundIdleGate {
  private controller = new AbortController();
  private waiters = new Set<() => void>();
  private resumeListeners = new Set<() => void>();
  paused = false;

  get signal(): AbortSignal { return this.controller.signal; }

  suspend(): void {
    if (this.paused) return;
    this.paused = true;
    this.controller.abort();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.controller = new AbortController();
    for (const wake of [...this.waiters]) wake();
    for (const listener of this.resumeListeners) listener();
  }

  onResume(listener: () => void): () => void {
    this.resumeListeners.add(listener);
    return () => { this.resumeListeners.delete(listener); };
  }

  wait(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (!this.paused) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => {
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", wake);
        resolve(!signal?.aborted);
      };
      this.waiters.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
  }
}

export const backgroundIdleGate = new BackgroundIdleGate();

export class BackgroundIdleController {
  private eligible = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly gate: BackgroundIdleGate,
    private readonly release: (stillIdle: () => boolean) => Promise<boolean>,
    private readonly delayMilliseconds = 15_000,
    private readonly retryMilliseconds = 3000,
  ) {
    // A tray action can wake the worker without opening a window.
    this.unsubscribe = gate.onResume(() => { if (this.eligible) this.update(false); });
  }

  update(eligible: boolean): void {
    if (this.disposed || eligible === this.eligible) return;
    this.eligible = eligible;
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!eligible) this.gate.resume();
    else this.schedule(this.delayMilliseconds, this.generation);
  }

  private schedule(delay: number, generation: number): void {
    this.timer = setTimeout(() => { void this.sleep(generation); }, delay);
    this.timer.unref();
  }

  private async sleep(generation: number): Promise<void> {
    const stillIdle = () => !this.disposed && this.eligible && this.generation === generation;
    if (!stillIdle()) return;
    this.gate.suspend();
    // Aborted observers first unwind their RPCs. Never terminate an in-flight job.
    const released = await this.release(stillIdle).catch(() => false);
    if (!released && stillIdle()) this.schedule(this.retryMilliseconds, generation);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    clearTimeout(this.timer);
    this.unsubscribe();
  }
}
