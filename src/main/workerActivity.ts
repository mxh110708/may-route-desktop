import type { Transport } from "@connectrpc/connect";

/** Counts a stream through consumption, not just until its headers arrive. */
export class WorkerActivity {
  private requests = 0;
  get busy(): boolean { return this.requests > 0; }

  constructor(private readonly operationSettled: () => void = () => {}) {}

  private acquire(): () => void {
    this.requests += 1;
    return () => { this.requests -= 1; };
  }

  track(transport: Transport): Transport {
    return {
      unary: async (...args) => {
        args[1]?.throwIfAborted();
        const release = this.acquire();
        try { return await transport.unary(...args); }
        finally { release(); this.operationSettled(); }
      },
      stream: async (...args) => {
        args[1]?.throwIfAborted();
        const release = this.acquire();
        try {
          const response = await transport.stream(...args);
          const settled = this.operationSettled;
          return {
            ...response,
            message: (async function* () {
              try { yield* response.message; }
              finally {
                release();
                if (!args[1]?.aborted) settled();
              }
            })(),
          };
        } catch (error) {
          release();
          throw error;
        }
      },
    };
  }
}
