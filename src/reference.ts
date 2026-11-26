import type { ListingId, PropertyGroup, PropertyType } from './types.ts';

/** Airbnb's numeric amenity ids, as its search filter panel uses them. */
export const AMENITIES: Record<string, number> = {
  wifi: 4,
  air_conditioning: 5,
  pool: 7,
  kitchen: 8,
  free_parking: 9,
  smoking_allowed: 11,
  gym: 15,
  breakfast: 16,
  hot_tub: 25,
  indoor_fireplace: 27,
  heating: 30,
  washer: 33,
  dryer: 34,
  smoke_alarm: 35,
  carbon_monoxide_alarm: 36,
  hair_dryer: 45,
  iron: 46,
  dedicated_workspace: 47,
  self_check_in: 51,
  tv: 58,
  ev_charger: 97,
  bbq_grill: 99,
  step_free_access: 110,
  wide_guest_entrance: 111,
  disabled_parking: 114,
  step_free_bedroom_access: 115,
  wide_bedroom_entrance: 116,
  step_free_bathroom_access: 120,
  wide_bathroom_entrance: 121,
  crib: 286,
  ceiling_hoist: 291,
  shower_grab_bar: 294,
  toilet_grab_bar: 295,
  step_free_shower: 296,
  shower_chair: 297,
  king_bed: 1000,
};

/** Search's l2 property type ids. */
export const PROPERTY_GROUP_IDS: Record<PropertyGroup, number> = {
  house: 1,
  guesthouse: 2,
  apartment: 3,
  hotel: 4,
};

const GROUPS: Record<string, PropertyGroup> = {
  HOUSE: 'house',
  GUESTHOUSE: 'guesthouse',
  PRIVATE_SUITE: 'guesthouse',
  APARTMENT: 'apartment',
  CONDOMINIUM: 'apartment',
  HOTEL: 'hotel',
};

/**
 * HOUSE is 'house'; GUESTHOUSE and PRIVATE_SUITE are 'guesthouse'; APARTMENT and CONDOMINIUM are
 * 'apartment'; HOTEL is 'hotel'. Types in no group, such as DOME, return null.
 */
export function propertyGroup(type: PropertyType): PropertyGroup | null {
  return GROUPS[type] ?? null;
}

export function listingUrl(id: ListingId): string {
  return `https://www.airbnb.com/rooms/${id}`;
}
