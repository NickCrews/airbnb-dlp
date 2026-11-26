/** Browsers, workers and edge runtimes: no default transport. */
import { makeCreateClient } from './client.ts';

export * from './public.ts';
export const createClient = makeCreateClient(null);
