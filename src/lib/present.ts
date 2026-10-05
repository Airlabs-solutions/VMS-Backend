import { statusLabel } from "../config/constants";
import { iso } from "./dates";
import { halalasToSar } from "./money";

export function sid(value: unknown): string | null {
  if (!value) return null;
  return String(value);
}

export function moneyDto(halalas: number) {
  return { halalas, sar: halalasToSar(halalas) };
}

export function statusDto(code: string) {
  return { code, label: statusLabel(code) };
}

export function dateDto(value: Date | string | null | undefined) {
  return iso(value);
}
