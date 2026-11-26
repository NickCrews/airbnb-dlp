import type { IsoDate } from './types.ts';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Day number since the Unix epoch, for date arithmetic without time zones. */
export function dayNumber(date: IsoDate): number {
  const m = ISO_RE.exec(date);
  if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

export function fromDayNumber(day: number): IsoDate {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(dayNumber(date) + days);
}

/** Yesterday in UTC, which is never later than the local date anywhere. */
export function safeToday(nowMs: number): IsoDate {
  return fromDayNumber(Math.floor(nowMs / 86_400_000) - 1);
}
