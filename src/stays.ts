import { addDays, dayNumber } from './dates.ts';
import type { Calendar, CalendarDay, IsoDate, Stay } from './types.ts';

/**
 * Every stay the calendar shows as bookable with check-in on or after `from`, applying
 * Airbnb's check-in, check-out and minimum and maximum night rules. Ordered by
 * check-in date, then length; lazy, so taking the first is cheap.
 */
export function* bookableStays(calendar: Calendar, from: IsoDate): Iterable<Stay> {
  const byDate = new Map<string, CalendarDay>();
  for (const day of calendar.days) byDate.set(day.date, day);
  const days = [...calendar.days].sort((a, b) => dayNumber(a.date) - dayNumber(b.date));
  for (const start of days) {
    if (start.date < from || !start.available || !start.checkInAllowed) continue;
    const minNights = Math.max(start.minNights ?? 1, 1);
    const maxNights = start.maxNights ?? Infinity;
    for (let nights = 1; nights <= maxNights; nights++) {
      // Every night of the stay must be available; the check-out day need not be.
      const night = byDate.get(addDays(start.date, nights - 1));
      if (!night || (nights > 1 && !night.available)) break;
      if (nights < minNights) continue;
      const checkOut = addDays(start.date, nights);
      const out = byDate.get(checkOut);
      if (!out) break;
      if (out.checkOutAllowed) yield { id: calendar.id, checkIn: start.date, checkOut };
    }
  }
}
