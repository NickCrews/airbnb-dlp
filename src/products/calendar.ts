import { graphql, nodeId } from '../airbnb.ts';
import type { Call } from '../call.ts';
import { safeToday } from '../dates.ts';
import { ShapeError } from '../parse-errors.ts';
import { asArray, asNumber, asRecord, dig } from '../json.ts';
import type { Calendar, CalendarDay, ListingId } from '../types.ts';

export const DEFAULT_MONTHS = 12;

export function calendarVariables(id: ListingId, today: string, months: number): Record<string, unknown> {
  return {
    listingId: nodeId('DemandStayListing', id),
    input: {
      count: months,
      month: Number(today.slice(5, 7)),
      year: Number(today.slice(0, 4)),
      // Without this, a hotel room gets the whole property's calendar.
      returnPropertyLevelCalendarIfApplicable: false,
    },
  };
}

/**
 * Days from `from` on. Airbnb starts at the 1st of the month and marks elapsed
 * days unavailable, so days before `from` are dropped rather than read as booked.
 */
export function parseCalendar(id: ListingId, json: unknown, from: string): Calendar {
  const months = dig(json, 'data.node.pdpAvailabilityCalendar.calendarMonths');
  if (!Array.isArray(months)) throw new ShapeError('calendar response has no calendarMonths');
  const days: CalendarDay[] = [];
  const seen = new Set<string>();
  for (const month of months) {
    for (const raw of asArray(asRecord(month)['days'])) {
      const day = asRecord(raw);
      const date = day['calendarDay'];
      if (typeof date !== 'string') throw new ShapeError('calendar day has no calendarDate');
      if (date < from || seen.has(date)) continue;
      seen.add(date);
      days.push({
        date,
        available: day['available'] === true,
        checkInAllowed: day['availableForCheckin'] === true,
        checkOutAllowed: day['availableForCheckout'] === true,
        minNights: asNumber(day['minNights']),
        maxNights: asNumber(day['maxNights']),
      });
    }
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { id, days };
}

export async function fetchCalendar(call: Call, id: ListingId, months: number): Promise<Calendar> {
  const today = safeToday(call.ctx.clock.now());
  const { json, result } = await graphql(call, 'PdpAvailabilityCalendarV2Query', calendarVariables(id, today, months));
  try {
    return parseCalendar(id, json, today);
  } catch (cause) {
    throw call.parseError(cause, result.exchange);
  }
}
