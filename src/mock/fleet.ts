/**
 * Mock fleet roster standing in for the TMS driver/asset tables.
 *
 * Phase 2 replaces this module with an MCP server over the real PostgreSQL
 * TMS. Everything here is deliberately pure and deterministic so a demo run
 * produces byte-identical numbers every time.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface Driver {
  driverId: string;
  name: string;
  /** Current GPS position. */
  position: GeoPoint;
  nearestCity: string;
  /** Legal driving minutes left in the current HOS cycle (FMCSA 11-hour rule). */
  hosMinutesRemaining: number;
  status: "AVAILABLE" | "ON_LOAD" | "OFF_DUTY" | "BREAKDOWN";
  /** Hourly rate used for overtime exposure. */
  hourlyRateUsd: number;
  /** Minutes already driven today; past 480 additional time bills as overtime. */
  minutesOnDutyToday: number;
  /** Set when the driver is currently carrying a load. */
  currentLoadId?: string;
}

export interface ThirdPartyCarrier {
  carrierId: string;
  name: string;
  /** Base spot rate per mile when tendering a recovery load. */
  spotRateUsdPerMile: number;
  /** Flat fee for accepting an emergency recovery tender. */
  emergencyAcceptanceFeeUsd: number;
  serviceRegions: string[];
}

/** Minutes of on-duty time before additional time bills at the overtime rate. */
export const STANDARD_SHIFT_MINUTES = 480;

/** Overtime multiplier applied to a driver's base hourly rate. */
export const OVERTIME_MULTIPLIER = 1.5;

/** All-in fuel + wear cost per mile for a company tractor. */
export const FUEL_COST_USD_PER_MILE = 0.62;

/** Flat cost of a driver-to-driver relay handoff (yard time, seal break, re-scan). */
export const RELAY_HANDOFF_FEE_USD = 75;

export const DRIVERS: Driver[] = [
  {
    driverId: "DRV-204",
    name: "Marcus Ellery",
    position: { lat: 33.7206, lon: -116.2156 },
    nearestCity: "Indio, CA",
    hosMinutesRemaining: 85,
    status: "ON_LOAD",
    hourlyRateUsd: 34,
    minutesOnDutyToday: 505,
    currentLoadId: "LOAD-4471",
  },
  {
    driverId: "DRV-217",
    name: "Priya Raman",
    position: { lat: 33.6803, lon: -116.1739 },
    nearestCity: "Coachella, CA",
    hosMinutesRemaining: 465,
    status: "AVAILABLE",
    hourlyRateUsd: 34,
    minutesOnDutyToday: 300,
  },
  {
    driverId: "DRV-221",
    name: "Dale Whitfield",
    position: { lat: 33.8303, lon: -116.5453 },
    nearestCity: "Palm Springs, CA",
    hosMinutesRemaining: 95,
    status: "AVAILABLE",
    hourlyRateUsd: 32,
    minutesOnDutyToday: 545,
  },
  {
    driverId: "DRV-231",
    name: "Sofia Marchetti",
    position: { lat: 40.8324, lon: -115.7631 },
    nearestCity: "Elko, NV",
    hosMinutesRemaining: 240,
    status: "BREAKDOWN",
    hourlyRateUsd: 36,
    minutesOnDutyToday: 410,
    currentLoadId: "LOAD-4472",
  },
  {
    driverId: "DRV-238",
    name: "Tomas Herrera",
    position: { lat: 39.5296, lon: -119.8138 },
    nearestCity: "Reno, NV",
    hosMinutesRemaining: 180,
    status: "AVAILABLE",
    hourlyRateUsd: 35,
    minutesOnDutyToday: 300,
  },
  {
    driverId: "DRV-245",
    name: "Ken Obara",
    position: { lat: 40.7608, lon: -111.891 },
    nearestCity: "Salt Lake City, UT",
    hosMinutesRemaining: 0,
    status: "OFF_DUTY",
    hourlyRateUsd: 35,
    minutesOnDutyToday: 660,
  },
];

export const CARRIERS: ThirdPartyCarrier[] = [
  {
    carrierId: "CAR-882",
    name: "Sierra Freight Partners",
    spotRateUsdPerMile: 3.15,
    emergencyAcceptanceFeeUsd: 260,
    serviceRegions: ["NV", "UT", "ID"],
  },
  {
    carrierId: "CAR-914",
    name: "Coachella Valley Drayage",
    spotRateUsdPerMile: 2.4,
    emergencyAcceptanceFeeUsd: 180,
    serviceRegions: ["CA", "AZ"],
  },
];

export function getDriver(driverId: string): Driver | undefined {
  return DRIVERS.find((d) => d.driverId === driverId);
}

export function getCarrier(carrierId: string): ThirdPartyCarrier | undefined {
  return CARRIERS.find((c) => c.carrierId === carrierId);
}

/** Great-circle distance in statute miles. */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const EARTH_RADIUS_MILES = 3958.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/**
 * Road miles are always longer than the great-circle line. 1.18 is a
 * conventional highway circuity factor.
 */
export const ROAD_CIRCUITY_FACTOR = 1.18;

export function roadMiles(a: GeoPoint, b: GeoPoint): number {
  return haversineMiles(a, b) * ROAD_CIRCUITY_FACTOR;
}
