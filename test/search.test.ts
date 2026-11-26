import { describe, expect, it } from 'vitest';
import { inBox, seedBands, splitBand, splitBox, unwrapBox } from '../src/products/search.ts';
import { nodeId } from '../src/airbnb.ts';
import { fakeTransport, graphqlVariables, ok, testClient } from './helpers.ts';
import type { TransportRequest } from '../src/types.ts';

describe('geometry', () => {
  it('splits a box crossing the antimeridian into two', () => {
    const aleutians = { south: 51, north: 53, west: 172, east: -178 };
    expect(unwrapBox(aleutians)).toEqual([
      { south: 51, north: 53, west: 172, east: 180 },
      { south: 51, north: 53, west: -180, east: -178 },
    ]);
    expect(inBox(aleutians, 52, 179)).toBe(true);
    expect(inBox(aleutians, 52, -179)).toBe(true);
    expect(inBox(aleutians, 52, 0)).toBe(false);
  });
  it('halves a box across its longer side and stops at 0.5 km', () => {
    const [a, b] = splitBox({ south: 61, north: 61.1, west: -150, east: -149 })!;
    expect(a.east).toBe(-149.5);
    expect(b.west).toBe(-149.5);
    expect(splitBox({ south: 61, north: 61.004, west: -150, east: -149.992 })).toBeNull();
  });
  it('splits price bands into halves sharing a boundary, down to one unit', () => {
    expect(splitBand(100, 200)).toEqual([[100, 150], [150, 200]]);
    expect(splitBand(100, 200, 120)).toEqual([[100, 125], [125, 150], [150, 175], [175, 200]]);
    expect(splitBand(100, 103, 500)).toEqual([[100, 101], [101, 102], [102, 103]]);
    expect(splitBand(1000, null)).toEqual([[1000, 2000], [2000, null]]);
    expect(splitBand(100, 101)).toBeNull();
  });
  it('clips seed bands to the query price range', () => {
    expect(seedBands({ min: 90, max: 130 })).toEqual([[90, 100], [100, 125], [125, 130]]);
    expect(seedBands(undefined).at(-1)).toEqual([1000, null]);
  });
});

/** A fake StaysSearch: listings at given points and prices; more than 40 matches give a second page. */
function fakeSearch(listings: { id: string; lat: number; lng: number; price: number }[]) {
  return (req: TransportRequest) => {
    const vars = graphqlVariables(req);
    const params = Object.fromEntries(
      (vars.staysSearchRequest.rawParams as { filterName: string; filterValues: string[] }[]).map((p) => [p.filterName, p.filterValues]),
    );
    const n = (k: string) => (params[k] ? Number(params[k][0]) : undefined);
    const [north, east, south, west] = [n('neLat')!, n('neLng')!, n('swLat')!, n('swLng')!];
    const min = n('price_min') ?? 0;
    const max = n('price_max') ?? Infinity;
    const match = listings.filter((l) => l.lat >= south && l.lat <= north && l.lng >= west && l.lng <= east && l.price >= min && l.price < max);
    const pages = Math.ceil(match.length / 40);
    return ok(
      JSON.stringify({
        data: {
          presentation: {
            staysSearch: {
              results: {
                paginationInfo: { pageCursors: Array.from({ length: Math.min(pages, 7) }, (_, i) => String(i)) },
                searchResults: match.slice(0, 40).map((l) => ({
                  __typename: 'StaySearchResult',
                  demandStayListing: { id: nodeId('DemandStayListing', l.id), location: { coordinate: { latitude: l.lat, longitude: l.lng } } },
                  structuredDisplayPrice: { primaryLine: { price: `$${l.price}`, qualifier: 'for 1 night' } },
                })),
              },
              mapResults: {},
            },
          },
        },
      }),
    );
  };
}

describe('search', () => {
  it('returns every listing in a dense area where many share a price', async () => {
    const listings = Array.from({ length: 500 }, (_, i) => ({
      id: String(1_000_000_000_000_000_000n + BigInt(i)),
      lat: 30.2 + (i % 25) * 0.004,
      lng: -97.8 + Math.floor(i / 25) * 0.005,
      price: i < 300 ? 120 : 50 + (i % 400),
    }));
    const t = fakeTransport(fakeSearch(listings));
    const query = { area: { bbox: { south: 30.19, north: 30.31, west: -97.81, east: -97.69 } } };
    const { items, outcome } = await testClient(t).search([query]).all();
    expect(outcome.incomplete).toEqual([]);
    expect(new Set(items.map((h) => h.listing.id)).size).toBe(500);
    expect(items).toHaveLength(500);
    expect(items[0]!.query).toBe(query);
  });

  it('drops listings outside the query box and reports a search that cannot be split', async () => {
    const listings = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), lat: 61.1, lng: -149.9, price: 100 }));
    listings.push({ id: '999', lat: 70, lng: -149.9, price: 100 });
    const t = fakeTransport(fakeSearch(listings));
    const { items, outcome } = await testClient(t).search([{ area: { bbox: { south: 61.0999, north: 61.1001, west: -149.9001, east: -149.8999 } } }]).all();
    expect(items.every((h) => h.listing.id !== '999')).toBe(true);
    expect(outcome.incomplete).toHaveLength(1);
  });

  it('sends each supported filter', async () => {
    const t = fakeTransport(fakeSearch([]));
    await testClient(t).search([
      {
        area: { bbox: { south: 1, north: 1.01, west: 1, east: 1.01 } },
        stay: { checkIn: '2027-01-01', checkOut: '2027-01-04' },
        guests: { adults: 2, pets: 1 },
        nightlyPrice: { min: 100, max: 120 },
        minBedrooms: 2,
        minBeds: 3,
        minBathrooms: 1,
        propertyGroups: ['house', 'apartment'],
        amenities: ['wifi', 'hot_tub'],
        instantBook: true,
      },
    ]).outcome();
    const search = t.requests.find((r) => r.url.includes('StaysSearch'))!;
    const params = Object.fromEntries(
      (graphqlVariables(search).staysSearchRequest.rawParams as { filterName: string; filterValues: string[] }[]).map((p) => [p.filterName, p.filterValues]),
    );
    expect(params).toMatchObject({
      checkin: ['2027-01-01'],
      checkout: ['2027-01-04'],
      priceFilterNumNights: ['3'],
      adults: ['2'],
      pets: ['1'],
      price_min: ['100'],
      price_max: ['120'],
      minBedrooms: ['2'],
      minBeds: ['3'],
      minBathrooms: ['1'],
      l2PropertyTypeIds: ['1', '3'],
      amenities: ['4', '25'],
      ib: ['true'],
    });
    expect(search.headers['X-Airbnb-Api-Key']).toBe('test-key');
  });

  it('rejects an unknown amenity', async () => {
    const t = fakeTransport(fakeSearch([]));
    const outcome = await testClient(t).search([{ area: { bbox: { south: 1, north: 1.01, west: 1, east: 1.01 } }, amenities: ['jacuzzi-ish'] }]).outcome();
    expect(outcome.incomplete[0]?.error.category).toBe('RequestRejected');
  });
});
