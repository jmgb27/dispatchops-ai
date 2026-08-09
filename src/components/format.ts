/**
 * Display formatting shared by the console panels.
 *
 * The demo is read by people who do not work in freight and by people who do,
 * so raw field values get turned into something both can read: dollars with a
 * currency symbol, and minutes as hours-and-minutes rather than "300 min".
 */

export const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Whole dollars — for headline figures where the cents are noise. */
export const usd0 = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

/** 300 → "5h 0m", 45 → "45m". */
export function humanMinutes(total: number): string {
  if (!Number.isFinite(total)) return "—";
  const minutes = Math.max(0, Math.round(total));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
