/**
 * The default transport on Node, Bun and Deno. impit sends Chrome's TLS
 * fingerprint; Airbnb sits behind Akamai, which refuses Node's own fetch.
 * Loaded lazily so importing the library costs nothing until a request is made.
 */
import type { Transport } from '../types.ts';

type ImpitModule = typeof import('impit');

export function impitTransport(): Transport {
  let client: Promise<InstanceType<ImpitModule['Impit']>> | null = null;
  const load = () =>
    (client ??= import('impit').then((m) => new m.Impit({ browser: 'chrome' })));
  return async (request, signal) => {
    const impit = await load();
    const response = await impit.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === null ? {} : { body: request.body }),
      signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  };
}
