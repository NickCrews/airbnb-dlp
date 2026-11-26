import { describe, expect, it } from 'vitest';
import { exactTotal } from '../src/products/priceQuote.ts';
import { parseReviewCountLabel } from '../src/products/search.ts';
import { fakeTransport, ok, testClient } from './helpers.ts';

describe('price quote totals', () => {
  const price = (items: { __typename?: string; priceString: string }[]) => ({
    explanationData: { priceDetails: [{ items: items.map((i) => ({ description: 'x', ...i })) }] },
  });
  it('sums the line items when they round to the displayed total', () => {
    expect(exactTotal(price([{ priceString: '$374.00' }, { priceString: '-$65.94' }, { __typename: 'HighlightExplanationLineItem', priceString: '$308.06' }]), 309)).toBe(308.06);
  });
  it('keeps the displayed total when the lines do not add up to it', () => {
    expect(exactTotal(price([{ priceString: '$241.00' }, { priceString: '$80.00' }]), 241)).toBe(241);
    expect(exactTotal({}, 99)).toBe(99);
  });
});

describe('search cards', () => {
  it('reads a review count from the accessibility label', () => {
    expect(parseReviewCountLabel('4.89 out of 5 average rating,  294 reviews')).toBe(294);
    expect(parseReviewCountLabel('4.74 out of 5 average rating')).toBeNull();
  });
});

describe('a removed listing on GraphQL products', () => {
  it('is NotFound, not RequestRejected', async () => {
    const t = fakeTransport(() =>
      ok(JSON.stringify({ errors: [{ message: 'Permission denied for id RGVtYW5kU3RheUxpc3Rpbmc6MQ==, with metadata: [...], path: /node, type: Query.Node' }], data: { node: null } })),
    );
    const { items } = await testClient(t).calendars(['1']).all();
    expect(!items[0]!.ok && items[0]!.error.category).toBe('NotFound');
  });
});
