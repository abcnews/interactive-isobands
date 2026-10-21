// workiq ships JSDoc only, no .d.ts files.
declare module 'workiq' {
  export class WorkerClient {
    /** Run inside the worker. Each method takes one payload and resolves to `[responsePayload, transferList]`. */
    constructor(methods: Record<string, (payload: any) => Promise<[unknown, Transferable[]?]>>);
  }

  export class WorkerHost {
    constructor(options: { workers?: Worker[]; logLevel?: string });
    addWorkers(workers: Worker[]): void;
    /** Queues a job for the next free worker. Rejects with the worker's error message. */
    push<T = unknown>(method: string, payload: unknown, options?: { transferList?: Transferable[] }): Promise<T>;
  }
}
