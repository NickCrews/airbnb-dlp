/** Node, Bun and Deno: impit is the default transport. */
import { makeCreateClient } from './client.ts';
import { impitTransport } from './transport/impit.ts';

export * from './public.ts';
export const createClient = makeCreateClient(impitTransport);
