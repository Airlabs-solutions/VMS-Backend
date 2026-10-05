import { formatDisplayDate } from "../../lib/dates";
import { formatSar } from "../../lib/money";

export function expiryMessage(kind: string, plate: string, expiry: Date, days: number): string {
  const when = formatDisplayDate(expiry);
  if (days <= 0) return `${kind} for ${plate} expired on ${when}.`;
  return `${kind} for ${plate} expires on ${when}. ${days} days left.`;
}

export function maintenanceDateMessage(plate: string, service: string, due: Date, days: number): string {
  const when = formatDisplayDate(due);
  if (days <= 0) return `${service} for ${plate} is overdue (due ${when}).`;
  return `${service} for ${plate} is due on ${when}. ${days} days left.`;
}

export function maintenanceKmMessage(plate: string, service: string, remaining: number): string {
  if (remaining <= 0) return `${service} for ${plate} is overdue by kilometers.`;
  return `${service} for ${plate} is due in ${remaining} km.`;
}

export function emiMessage(plate: string, due: Date, amountHalalas: number, days: number): string {
  const when = formatDisplayDate(due);
  const amount = formatSar(amountHalalas);
  if (days <= 0) return `EMI of ${amount} for ${plate} was due on ${when} and is unpaid.`;
  return `EMI of ${amount} for ${plate} is due on ${when}. ${days} days left.`;
}

export function violationMessage(plate: string, amountHalalas: number): string {
  return `A Saher violation of ${formatSar(amountHalalas)} was logged for ${plate}.`;
}
