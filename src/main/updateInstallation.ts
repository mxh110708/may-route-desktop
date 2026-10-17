/** Keeps cancellation effective until the synchronous installer handoff. */
export class UpdateInstallation {
  private active: {
    controller: AbortController;
    downloading: boolean;
    settled: Promise<void>;
    settle(): void;
  } | undefined;

  async run<T>(
    download: (signal: AbortSignal) => Promise<string>,
    install: (path: string) => Promise<T>,
  ): Promise<T | "cancelled"> {
    if (this.active !== undefined) throw new Error("update installation already in progress");
    let settle!: () => void;
    const task = {
      controller: new AbortController(),
      downloading: true,
      settled: new Promise<void>((resolve) => { settle = resolve; }),
      settle: () => settle(),
    };
    this.active = task;
    try {
      const path = await download(task.controller.signal);
      task.controller.signal.throwIfAborted();
      // No await between this guard and the installer handoff.
      task.downloading = false;
      return await install(path);
    } catch (error) {
      if (task.downloading && task.controller.signal.aborted) return "cancelled";
      throw error;
    } finally {
      this.active = undefined;
      task.settle();
    }
  }

  async cancel(): Promise<boolean> {
    const task = this.active;
    if (task === undefined || !task.downloading) return false;
    task.controller.abort(new DOMException("Update download cancelled", "AbortError"));
    // The caller can retry only after the stream and temporary file are closed.
    await task.settled;
    return true;
  }
}
