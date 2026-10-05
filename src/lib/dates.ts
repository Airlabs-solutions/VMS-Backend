const RIYADH = "Asia/Riyadh";

export function riyadhDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RIYADH,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatDisplayDate(date: Date | string | null | undefined): string {
  if (!date) return "";
  const value = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return "";
  const key = riyadhDateKey(value);
  const [year, month, day] = key.split("-");
  return `${day}/${month}/${year}`;
}

/** Whole days from `from` to `to` on the Asia/Riyadh calendar. Negative when `to` is earlier. */
export function daysBetween(from: Date, to: Date): number {
  const a = Date.parse(`${riyadhDateKey(from)}T00:00:00Z`);
  const b = Date.parse(`${riyadhDateKey(to)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCMonth(next.getUTCMonth() + months);
  if (next.getUTCDate() < day) {
    next.setUTCDate(0);
  }
  return next;
}

export function clampDueDay(year: number, monthIndex: number, dueDay: number): Date {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const day = Math.min(dueDay, last);
  return new Date(Date.UTC(year, monthIndex, day));
}

export function iso(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  const value = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}
