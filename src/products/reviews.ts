import { graphql, nodeId } from '../airbnb.ts';
import type { Call } from '../call.ts';
import { ShapeError } from '../parse-errors.ts';
import { asArray, asNumber, asRecord, dig } from '../json.ts';
import type { ListingId, Review, Reviews } from '../types.ts';

export const REVIEWS_PAGE_SIZE = 24;

export function reviewsVariables(id: ListingId, offset: number, limit: number): Record<string, unknown> {
  return {
    // Reviews take a StayListing id, not DemandStayListing.
    id: nodeId('StayListing', id),
    pdpReviewsRequest: {
      fieldSelector: 'for_p3_translation_only',
      forPreview: false,
      limit,
      offset: String(offset),
      showingTranslationButton: false,
      first: limit,
      sortingPreference: 'MOST_RECENT',
      numberOfAdults: '1',
      numberOfChildren: '0',
      numberOfInfants: '0',
      numberOfPets: '0',
      after: null,
    },
  };
}

export function parseReviewsPage(json: unknown): { total: number | null; reviews: Review[] } {
  const root = dig(json, 'data.presentation.stayProductDetailPage.reviews');
  if (typeof root !== 'object' || root === null) throw new ShapeError('reviews response has no reviews object');
  const list = asRecord(root)['reviews'];
  if (!Array.isArray(list)) throw new ShapeError('reviews response has no reviews list');
  const reviews: Review[] = [];
  for (const raw of asArray(list)) {
    const createdAt = asRecord(raw)['createdAt'];
    if (typeof createdAt !== 'string') throw new ShapeError('review has no createdAt');
    reviews.push({ createdAt: normaliseTimestamp(createdAt) });
  }
  return { total: asNumber(dig(root, 'metadata.reviewsCount')), reviews };
}

/** Airbnb sends "2024-05-01T17:03:11Z"; any parseable timestamp is returned in that form. */
function normaliseTimestamp(raw: string): string {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new ShapeError(`review createdAt is not a timestamp: ${raw}`);
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

export async function fetchReviews(call: Call, id: ListingId, limit: number | 'all'): Promise<Reviews> {
  const want = limit === 'all' ? Infinity : limit;
  const reviews: Review[] = [];
  let total: number | null = null;
  while (reviews.length < want) {
    const size = Math.min(REVIEWS_PAGE_SIZE, want - reviews.length);
    const { json, result } = await graphql(call, 'StaysPdpReviewsQuery', reviewsVariables(id, reviews.length, size));
    let page: ReturnType<typeof parseReviewsPage>;
    try {
      page = parseReviewsPage(json);
    } catch (cause) {
      throw call.parseError(cause, result.exchange);
    }
    total = page.total ?? total;
    reviews.push(...page.reviews);
    if (page.reviews.length < size) break;
    if (total !== null && reviews.length >= total) break;
  }
  return { id, total, reviews };
}
