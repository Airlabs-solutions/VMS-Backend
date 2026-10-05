import { EXPIRY_SOON_DAYS, MAINTENANCE_SOON_DAYS, MAINTENANCE_SOON_KM } from "../config/constants";
import { daysBetween } from "./dates";

export type DateStatus = "valid" | "expiring_soon" | "expired";
export type DueStatus = "ok" | "due_soon" | "overdue";

export function expiryStatus(expiry: Date, now = new Date()): DateStatus {
  const days = daysBetween(now, expiry);
  if (days < 0) return "expired";
  if (days <= EXPIRY_SOON_DAYS) return "expiring_soon";
  return "valid";
}

export function maintenanceStatus(input: {
  nextDueDate?: Date | null;
  nextDueKm?: number | null;
  odometerKm: number;
  now?: Date;
}): DueStatus {
  const now = input.now ?? new Date();
  const dateOverdue = input.nextDueDate ? daysBetween(now, input.nextDueDate) < 0 : false;
  const kmOverdue = input.nextDueKm != null && input.odometerKm >= input.nextDueKm;
  if (dateOverdue || kmOverdue) return "overdue";

  const dateSoon = input.nextDueDate ? daysBetween(now, input.nextDueDate) <= MAINTENANCE_SOON_DAYS : false;
  const kmSoon = input.nextDueKm != null && input.odometerKm >= input.nextDueKm - MAINTENANCE_SOON_KM;
  if (dateSoon || kmSoon) return "due_soon";
  return "ok";
}

/**
 * Pick the alert offset bucket for a daily job.
 * Offsets are day counts (or km remaining for maintenance_km, handled separately).
 * A value is included in the largest offset it has reached, so a missed day still alerts once.
 */
export function matchingOffset(value: number, offsets: number[]): number | null {
  const sorted = [...offsets].sort((a, b) => b - a);
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (next === undefined) {
      if (value <= current) return current;
    } else if (value <= current && value > next) {
      return current;
    }
  }
  return null;
}
