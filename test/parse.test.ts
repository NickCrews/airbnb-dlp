import { describe, expect, it } from 'vitest';
import { parseBathrooms, parseBedrooms } from '../src/products/listing.ts';
import { parseRating, parseSearchListing } from '../src/products/search.ts';
import { bookableStays, listingUrl, propertyGroup } from '../src/public.ts';
import { safeToday } from '../src/dates.ts';
import { decodeNodeId, nodeId, parseApiKey } from '../src/airbnb.ts';

describe('listing text', () => {
  it.each([
    ['2 bedrooms', 2],
    ['1 bedroom', 1],
    ['Studio', 0],
    ['Lots of rooms', null],
  ])('bedrooms %s', (text, count) => expect(parseBedrooms(text)).toBe(count));

  it.each([
    ['1.5 shared baths', 1.5, 'shared'],
    ['2 baths', 2, 'private'],
    ['1 private bath', 1, 'private'],
    ['1 dedicated bathroom', 1, 'dedicated'],
    ['Half-bath', 0.5, 'private'],
    ['Shared half-bath', 0.5, 'shared'],
    ['No bathroom', 0, null],
    ['Shared bathroom', null, 'shared'],
    ['Private attached bathroom', null, 'private'],
    ['Outdoor shower', null, null],
  ])('bathrooms %s', (text, count, access) => expect(parseBathrooms(text)).toEqual({ count, access }));
});

describe('helpers', () => {
  it('maps property types to search groups', () => {
    expect(propertyGroup('HOUSE')).toBe('house');
    expect(propertyGroup('PRIVATE_SUITE')).toBe('guesthouse');
    expect(propertyGroup('CONDOMINIUM')).toBe('apartment');
    expect(propertyGroup('HOTEL')).toBe('hotel');
    expect(propertyGroup('DOME')).toBeNull();
  });
  it('builds listing URLs', () => expect(listingUrl('1602507228357075578')).toBe('https://www.airbnb.com/rooms/1602507228357075578'));
  it('round-trips 19-digit node ids without precision loss', () => {
    expect(decodeNodeId(nodeId('DemandStayListing', '1602507228357075578'))).toBe('1602507228357075578');
    expect(decodeNodeId('RGVtYW5kVXNlcjo2NTQ5NzM5MjE=', 'DemandUser')).toBe('654973921');
    expect(decodeNodeId('RGVtYW5kVXNlcjo2NTQ5NzM5MjE=', 'DemandStayListing')).toBeNull();
    expect(decodeNodeId('not base64!')).toBeNull();
  });
  it('reads the API key from the homepage', () => expect(parseApiKey('x"api_config":{"key":"abc123","baseUrl":"/api"}')).toBe('abc123'));
  it('uses yesterday in UTC as today', () => expect(safeToday(Date.UTC(2026, 0, 1, 3))).toBe('2025-12-31'));
});

describe('search card', () => {
  const card = {
    __typename: 'StaySearchResult',
    avgRatingLocalized: '4.96 (1,050)',
    badges: [{ loggingContext: { badgeType: 'GUEST_FAVORITE' } }],
    demandStayListing: {
      id: 'RGVtYW5kU3RheUxpc3Rpbmc6MTYwMjUwNzIyODM1NzA3NTU3OA==',
      location: { coordinate: { latitude: 61.2, longitude: -149.9 } },
      description: { name: { localizedStringWithTranslationPreference: 'Cozy cabin' } },
    },
    structuredDisplayPrice: {
      primaryLine: { __typename: 'DiscountedDisplayPriceLine', discountedPrice: '$936', originalPrice: '$1,100', qualifier: 'for 5 nights' },
      explanationData: { priceDetails: [{ items: [{ description: '5 nights x $187.20', priceString: '$936.00' }] }] },
    },
  };
  it('parses every field', () => {
    expect(parseSearchListing(card, 'USD')).toEqual({
      id: '1602507228357075578',
      name: 'Cozy cabin',
      location: { lat: 61.2, lng: -149.9 },
      rating: 4.96,
      reviewCount: 1050,
      badges: ['GUEST_FAVORITE'],
      price: { total: { amount: 936, currency: 'USD' }, nights: 5, nightly: { amount: 187.2, currency: 'USD' } },
    });
  });
  it('skips results that are not stays', () => expect(parseSearchListing({ __typename: 'Ad' }, 'USD')).toBeNull());
  it('reads ratings with and without counts', () => {
    expect(parseRating('4.8')).toEqual({ rating: 4.8, reviewCount: null });
    expect(parseRating('New')).toEqual({ rating: null, reviewCount: null });
  });
});

describe('bookableStays', () => {
  const day = (date: string, o: Partial<{ available: boolean; checkInAllowed: boolean; checkOutAllowed: boolean; minNights: number; maxNights: number }> = {}) => ({
    date,
    available: true,
    checkInAllowed: true,
    checkOutAllowed: true,
    minNights: 1,
    maxNights: 30,
    ...o,
  });
  it('applies minimum nights, check-in and check-out rules, in order', () => {
    const cal = {
      id: '1',
      days: [
        day('2026-12-01', { checkInAllowed: false }),
        day('2026-12-02', { minNights: 2, maxNights: 3 }),
        day('2026-12-03'),
        day('2026-12-04', { checkOutAllowed: false }),
        day('2026-12-05', { available: false }),
        day('2026-12-06', { available: false }),
      ],
    };
    const stays = [...bookableStays(cal, '2026-12-01')].map((s) => `${s.checkIn}/${s.checkOut}`);
    expect(stays).toEqual(['2026-12-02/2026-12-05', '2026-12-03/2026-12-05', '2026-12-04/2026-12-05']);
  });
  it('is lazy', () => {
    const days = Array.from({ length: 365 }, (_, i) => day(new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10), { maxNights: 365 }));
    const first = bookableStays({ id: '1', days }, '2027-01-01')[Symbol.iterator]().next();
    expect(first.value).toEqual({ id: '1', checkIn: '2027-01-01', checkOut: '2027-01-02' });
  });
});
