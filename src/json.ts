/** Helpers for reading untyped JSON without trusting its shape. */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function dig(root: unknown, path: string): unknown {
  let current = root;
  for (const key of path.split('.')) {
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isRecord(current)) current = current[key];
    else return undefined;
  }
  return current;
}

/** Every object in the tree, depth first, the root included. */
export function* objects(root: unknown): Generator<JsonRecord> {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
    } else if (isRecord(node)) {
      yield node;
      const values = Object.values(node);
      for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
    }
  }
}

/** The distinct values found under `key` anywhere in the tree that pass `accept`. */
export function distinct<T>(root: unknown, key: string, accept: (value: unknown) => value is T): T[] {
  const seen = new Set<T>();
  for (const obj of objects(root)) {
    if (key in obj && accept(obj[key])) seen.add(obj[key]);
  }
  return [...seen];
}

/** The one distinct value under `key`, or null when there is none or more than one. */
export function only<T>(root: unknown, key: string, accept: (value: unknown) => value is T): T | null {
  const values = distinct(root, key, accept);
  return values.length === 1 ? values[0]! : null;
}

export const isString = (v: unknown): v is string => typeof v === 'string' && v !== '';
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `"$1,234.50"` is 1234.5; a leading minus, as in `"-$110.00"`, makes it negative. */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replaceAll(',', '').trim();
  const match = /\d+(?:\.\d+)?/.exec(cleaned);
  if (!match) return null;
  const n = Number(match[0]);
  return cleaned.startsWith('-') || cleaned.startsWith('−') ? -n : n;
}
