import { AppError } from "./errors";

/**
 * Store mobiles in E.164.
 * Saudi local forms (05xxxxxxxx) stay +9665xxxxxxxx.
 * Any other number with 7 to 15 digits is accepted.
 */
export function normalizeSaudiMobile(input: string): string {
  let compact = input.trim().replace(/[\s().-]/g, "");
  if (compact.startsWith("00")) compact = `+${compact.slice(2)}`;
  const digits = compact.replace(/\D/g, "");

  const saudiLocal = digits.match(/^(?:966)?0?(5\d{8})$/);
  if (saudiLocal && (digits.length === 9 || digits.length === 10 || digits.startsWith("966"))) {
    return `+966${saudiLocal[1]}`;
  }

  if (digits.length < 7 || digits.length > 15) {
    throw new AppError(400, "INVALID_MOBILE", "Enter a valid mobile number");
  }
  return `+${digits}`;
}

export function formatSaudiMobile(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length !== 12) return e164;
  const local = digits.slice(3);
  return `+966 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
}

export function maskMobile(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return `***** ${last4}`;
}

export function maskMobileLast4(last4: string): string {
  return `***** ${last4}`;
}

export function maskIdNumber(value: string): string {
  const digits = value.replace(/\s/g, "");
  if (digits.length <= 4) return "****";
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}
