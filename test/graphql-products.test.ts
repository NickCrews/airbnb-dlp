import { describe, expect, it } from 'vitest';
import { fakeTransport, graphqlVariables, ok, testClient } from './helpers.ts';

const json = (o: unknown) => ok(JSON.stringify(o));

describe('calendars', () => {
  it('drops days before today and maps day rules', async () => {
    const t = fakeTransport(() =>
      json({
        data: {
          node: {
            pdpAvailabilityCalendar: {
              calendarMonths: [
                {
                  days: [
                    { calendarDate: '2026-11-24', available: false, availableForCheckin: false, availableForCheckout: false, minNights: 2, maxNights: 30 },
                    { calendarDate: '2026-11-25', available: true, availableForCheckin: true, availableForCheckout: false, minNights: 2, maxNights: 30 },
                  ],
                },
              ],
            },
          },
        },
      }),
    );
    const { items } = await testClient(t).calendars(['42'], { months: 2 }).all();
    const r = items[0]!;
    expect(r.ok && r.value).toEqual({
      id: '42',
      days: [{ date: '2026-11-25', available: true, checkInAllowed: true, checkOutAllowed: false, minNights: 2, maxNights: 30 }],
    });
    const vars = graphqlVariables(t.requests[1]!);
    expect(vars.input).toMatchObject({ count: 2, month: 11, year: 2026 });
  });

  it('reports a changed response shape as ResponseChanged', async () => {
    const t = fakeTransport(() => json({ data: { node: {} } }));
    const { items } = await testClient(t).calendars(['42']).all();
    expect(!items[0]!.ok && items[0]!.error.category).toBe('ResponseChanged');
  });

  it('reports a rotated query id as RequestRejected', async () => {
    const t = fakeTransport(() => json({ errors: [{ message: 'PersistedQueryNotFound' }] }));
    const { items } = await testClient(t).calendars(['42']).all();
    expect(!items[0]!.ok && items[0]!.error.category).toBe('RequestRejected');
  });

  it('treats an HTML page where JSON was expected as Blocked', async () => {
    const t = fakeTransport(() => ok('<html>bot check</html>'));
    const outcome = await testClient(t).calendars(['42']).outcome();
    expect(outcome.error?.category).toBe('Blocked');
  });
});

describe('priceQuotes', () => {
  const stay = { id: '42', checkIn: '2027-01-01', checkOut: '2027-01-03', guests: { adults: 2 } };
  it('reads the total and breakdown', async () => {
    const t = fakeTransport(() =>
      json({
        data: {
          node: {
            pdpPresentation: {
              bookIt: {
                structuredDisplayPrice: {
                  primaryLine: {
                    __typename: 'OrderedDisplayPriceLine',
                    orderedComponents: [{ leadingContent: 'From' }, { originalPrice: '$300' }, { discountedPrice: '$241' }, { qualifier: 'for 2 nights' }],
                  },
                  explanationData: {
                    priceDetails: [{ items: [{ description: '2 nights x $120.50', priceString: '$241.00' }, { description: 'Cleaning fee', priceString: '$80.00' }] }],
                  },
                },
              },
            },
          },
        },
      }),
    );
    const { items } = await testClient(t).priceQuotes([stay]).all();
    expect(items[0]!.ok && items[0]!.value).toEqual({
      total: { amount: 241, currency: 'USD' },
      breakdown: ['2 nights x $120.50 $241.00', 'Cleaning fee $80.00'],
    });
    expect(graphqlVariables(t.requests[1]!).guestCounts).toEqual({ numberOfAdults: 2, numberOfChildren: 0, numberOfInfants: 0, numberOfPets: 0 });
  });

  it('reports a stay Airbnb will not quote as StayUnavailable with its reason', async () => {
    const t = fakeTransport(() =>
      json({ data: { node: { pdpPresentation: { bookIt: { structuredDisplayPrice: null, availability: { unavailabilityMessage: 'Those dates are not available' } } } } } }),
    );
    const { items } = await testClient(t).priceQuotes([stay]).all();
    const r = items[0]!;
    expect(!r.ok && [r.error.category, r.error.message]).toEqual(['StayUnavailable', 'Those dates are not available']);
  });
});

describe('reviews', () => {
  const page = (n: number, offset: number) => ({
    data: {
      presentation: {
        stayProductDetailPage: {
          reviews: {
            metadata: { reviewsCount: 30 },
            reviews: Array.from({ length: n }, (_, i) => ({ createdAt: new Date(Date.UTC(2026, 9, 30 - offset - i)).toISOString() })),
          },
        },
      },
    },
  });
  it('pages to the oldest review by default', async () => {
    const t = fakeTransport((req) => {
      const { offset, limit } = graphqlVariables(req).pdpReviewsRequest;
      return json(page(Math.min(limit, 30 - Number(offset)), Number(offset)));
    });
    const { items } = await testClient(t).reviews(['42']).all();
    const r = items[0]!;
    expect(r.ok && r.value.reviews).toHaveLength(30);
    expect(r.ok && r.value.total).toBe(30);
    expect(r.ok && r.value.reviews[0]!.createdAt).toBe('2026-10-30T00:00:00Z');
    expect(atob(graphqlVariables(t.requests[1]!).id)).toBe('StayListing:42');
  });
  it('stops at the limit', async () => {
    const t = fakeTransport((req) => {
      const { offset, limit } = graphqlVariables(req).pdpReviewsRequest;
      return json(page(limit, Number(offset)));
    });
    const { items } = await testClient(t).reviews(['42'], { limit: 5 }).all();
    expect(items[0]!.ok && items[0]!.value.reviews).toHaveLength(5);
  });
});
