import { describe, expect, it } from "vitest";
import { formatSar, sarToHalalas } from "../lib/money";
import { normalizeSaudiMobile } from "../lib/phone";
import { expiryStatus, maintenanceStatus, matchingOffset } from "../lib/status";

describe("money", () => {
  it("stores SAR as halalas", () => {
    expect(sarToHalalas(1250)).toBe(125000);
    expect(sarToHalalas(10.5)).toBe(1050);
    expect(formatSar(125000)).toBe("SAR 1,250.00");
  });
});

describe("phone", () => {
  it("normalizes Saudi mobiles and accepts other countries", () => {
    expect(normalizeSaudiMobile("0512345678")).toBe("+966512345678");
    expect(normalizeSaudiMobile("+966 51 234 5678")).toBe("+966512345678");
    expect(normalizeSaudiMobile("+1 202 555 0100")).toBe("+12025550100");
    expect(normalizeSaudiMobile("00971501234567")).toBe("+971501234567");
  });
});

describe("status", () => {
  it("marks expiry windows", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    expect(expiryStatus(new Date("2026-08-01T00:00:00Z"), now)).toBe("expired");
    expect(expiryStatus(new Date("2026-09-20T00:00:00Z"), now)).toBe("expiring_soon");
    expect(expiryStatus(new Date("2027-01-01T00:00:00Z"), now)).toBe("valid");
  });

  it("uses date or kilometers, whichever is worse", () => {
    expect(maintenanceStatus({
      nextDueDate: new Date("2026-12-01"),
      nextDueKm: 10000,
      odometerKm: 10000,
      now: new Date("2026-09-01"),
    })).toBe("overdue");
  });

  it("buckets alert offsets once", () => {
    expect(matchingOffset(31, [30, 15, 7, 0])).toBeNull();
    expect(matchingOffset(30, [30, 15, 7, 0])).toBe(30);
    expect(matchingOffset(10, [30, 15, 7, 0])).toBe(15);
    expect(matchingOffset(0, [30, 15, 7, 0])).toBe(0);
    expect(matchingOffset(-2, [30, 15, 7, 0])).toBe(0);
    expect(matchingOffset(400, [500, 0])).toBe(500);
    expect(matchingOffset(600, [500, 0])).toBeNull();
  });
});
