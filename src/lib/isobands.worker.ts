import { WorkerClient } from 'workiq';
import { createIsobands, type CreateIsobandsOptions } from './createisobands.ts';

/** What the host sends for a `createIsobands` job. Palettes are applied back on the main thread, as functions can't be posted. */
export type CreateIsobandsJob = {
  buffer: ArrayBuffer;
  options: Omit<CreateIsobandsOptions, 'palette'>;
};

new WorkerClient({
  createIsobands: async ({ buffer, options }: CreateIsobandsJob) => [await createIsobands(buffer, options), []]
});
