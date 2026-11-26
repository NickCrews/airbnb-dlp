import { graphql, nodeId } from '../airbnb.ts';
import type { Call } from '../call.ts';
import { AirbnbError } from '../errors.ts';
import { ShapeError } from '../parse-errors.ts';
import { asArray, asRecord, asString, isRecord, parseAmount } from '../json.ts';
import type { PriceQuote, Stay } from '../types.ts';

export function priceQuoteVariables(stay: Stay): Record<string, unknown> {
  const dates = { startDate: stay.checkIn, endDate: stay.checkOut };
  const g = stay.guests;
  return {
    id: nodeId('DemandStayListing', stay.id),
    dateRange: dates,
    guestCounts: g
      ? {
          numberOfAdults: g.adults ?? 1,
          numberOfChildren: g.children ?? 0,
          numberOfInfants: g.infants ?? 0,
          numberOfPets: g.pets ?? 0,
        }
      : null,
    // The query rejects a request that leaves out any of these.
    includePdpMigrationBookItCalendarSheetFragment: false,
    includePdpMigrationBookItFloatingFooterFragment: false,
    includePdpMigrationBookItNavFragment: false,
    includePdpMigrationBookItSidebarFragment: true,
    includeGalleryBookItCtaFragment: false,
    includeOverviewMerchandisingTipsFragment: false,
    includeStaysPdpPriceHeatmapFragment: false,
    priceHeatmapDateRange: dates,
    p3ImpressionId: null,
    selectedCancellationPolicyId: null,
    causeId: null,
    selectedGuestOptionId: null,
    federatedSearchId: null,
    interactionType: null,
    logEntityPricingViewEvent: false,
  };
}

/**
 * The displayed total from a price line. A DiscountedDisplayPriceLine has
 * discountedPrice, a QualifiedDisplayPriceLine has price, and an
 * OrderedDisplayPriceLine carries them on its orderedComponents.
 */
export function lineTotal(line: Record<string, unknown>): number | null {
  const parts = [line, ...asArray(line['orderedComponents']).map(asRecord)];
  for (const key of ['discountedPrice', 'price']) {
    for (const part of parts) {
      const amount = parseAmount(part[key]);
      if (amount !== null) return amount;
    }
  }
  return null;
}

/**
 * The exact total: the sum of the breakdown's line items, without summary
 * lines such as "Price after discount". The displayed total is rounded to
 * whole units, so the sum is used only when it rounds to it.
 */
export function exactTotal(price: Record<string, unknown>, displayed: number): number {
  let sum = 0;
  let lines = 0;
  for (const group of asArray(asRecord(price['explanationData'])['priceDetails'])) {
    for (const item of asArray(asRecord(group)['items'])) {
      const it = asRecord(item);
      if (it['__typename'] === 'HighlightExplanationLineItem') continue;
      const amount = parseAmount(it['priceString']);
      if (amount === null) continue;
      sum += amount;
      lines++;
    }
  }
  const rounded = Math.round(sum * 100) / 100;
  return lines > 0 && Math.abs(rounded - displayed) < 1 ? rounded : displayed;
}

export function breakdownLines(price: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const group of asArray(asRecord(price['explanationData'])['priceDetails'])) {
    for (const item of asArray(asRecord(group)['items'])) {
      const description = asString(asRecord(item)['description']);
      const amount = asString(asRecord(item)['priceString']);
      if (description !== null) lines.push(amount === null ? description : `${description} ${amount}`);
    }
  }
  return lines;
}

export function parsePriceQuote(json: unknown, currency: string): PriceQuote {
  const bookIt = asRecord(asRecord(asRecord(json)['data'])['node'])['pdpPresentation'];
  const section = asRecord(bookIt)['bookIt'];
  if (!isRecord(section)) throw new ShapeError('price quote response has no pdpPresentation.bookIt');
  const price = section['structuredDisplayPrice'];
  if (!isRecord(price)) {
    const reason = asString(asRecord(section['availability'])['unavailabilityMessage']);
    throw new AirbnbError('StayUnavailable', reason ?? 'Airbnb gave no price for this stay');
  }
  const total = lineTotal(asRecord(price['primaryLine']));
  if (total === null) throw new ShapeError('price line has no total');
  return { total: { amount: exactTotal(price, total), currency }, breakdown: breakdownLines(price) };
}

export async function fetchPriceQuote(call: Call, stay: Stay): Promise<PriceQuote> {
  const { json, result } = await graphql(call, 'StaysPdpBookItQuery', priceQuoteVariables(stay));
  try {
    return parsePriceQuote(json, call.ctx.currency);
  } catch (cause) {
    if (cause instanceof AirbnbError) {
      throw new AirbnbError(cause.category, cause.message, { exchange: result.exchange });
    }
    throw call.parseError(cause, result.exchange);
  }
}
