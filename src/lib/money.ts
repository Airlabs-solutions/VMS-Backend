export function sarToHalalas(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Invalid amount");
  }
  return Math.round((value + Number.EPSILON) * 100);
}

export function halalasToSar(halalas: number): number {
  return Math.round(halalas) / 100;
}

export function formatSar(halalas: number): string {
  const negative = halalas < 0;
  const abs = Math.abs(Math.round(halalas));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const grouped = whole.toLocaleString("en-US");
  return `SAR ${negative ? "-" : ""}${grouped}.${frac}`;
}
