export const ROLES = ["super_admin", "company_admin", "driver"] as const;
export type Role = (typeof ROLES)[number];

export const VEHICLE_STATUSES = ["active", "in_maintenance", "inactive", "sold"] as const;
export const OWNERSHIP_TYPES = ["owned", "financed", "leased"] as const;
export const VEHICLE_TYPES = ["sedan", "suv", "pickup", "van", "truck", "bus", "motorcycle", "other"] as const;
export const FUEL_TYPES = ["petrol", "diesel", "hybrid", "electric", "other"] as const;
export const INSURANCE_TYPES = ["comprehensive", "third_party"] as const;
export const CLAIM_STATUSES = ["submitted", "approved", "rejected", "paid"] as const;
export const INSTALLMENT_STATUSES = ["unpaid", "paid"] as const;
export const VIOLATION_STATUSES = ["unpaid", "paid", "disputed"] as const;
export const FUEL_APPROVAL = ["pending", "approved", "rejected"] as const;
export const EXPENSE_CATEGORIES = ["tolls", "parking", "washing", "tires", "spare_parts", "fines", "other"] as const;
export const LICENSE_TYPES = ["private", "light_transport", "heavy", "motorcycle", "other"] as const;
export const USER_STATUSES = ["active", "inactive"] as const;
export const COMPANY_STATUSES = ["active", "suspended"] as const;
export const ALERT_TYPES = [
  "istimara_expiry",
  "insurance_expiry",
  "maintenance_date",
  "maintenance_km",
  "license_expiry",
  "iqama_expiry",
  "emi_due",
  "violation_created",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_DEFAULTS: Record<AlertType, { offsets: number[]; recipients: Array<"admin" | "driver"> }> = {
  istimara_expiry: { offsets: [30, 15, 7, 0], recipients: ["admin"] },
  insurance_expiry: { offsets: [30, 15, 7, 0], recipients: ["admin"] },
  maintenance_date: { offsets: [7, 0], recipients: ["admin", "driver"] },
  maintenance_km: { offsets: [500, 0], recipients: ["admin", "driver"] },
  license_expiry: { offsets: [30, 7], recipients: ["admin", "driver"] },
  iqama_expiry: { offsets: [30, 7], recipients: ["admin", "driver"] },
  emi_due: { offsets: [3, 0], recipients: ["admin"] },
  violation_created: { offsets: [0], recipients: ["admin", "driver"] },
};

export const STATUS_LABELS: Record<string, string> = {
  ok: "OK",
  due_soon: "Due soon",
  overdue: "Overdue",
  valid: "Valid",
  expiring_soon: "Expiring soon",
  expired: "Expired",
  active: "Active",
  in_maintenance: "In maintenance",
  inactive: "Inactive",
  sold: "Sold",
  suspended: "Suspended",
  paid: "Paid",
  unpaid: "Unpaid",
  disputed: "Disputed",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  pending: "Pending",
  owned: "Owned",
  financed: "Financed",
  leased: "Leased",
  comprehensive: "Comprehensive",
  third_party: "Third party",
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  open: "Open",
  dismissed: "Dismissed",
  tolls: "Tolls",
  parking: "Parking",
  washing: "Washing",
  tires: "Tires",
  spare_parts: "Spare parts",
  fines: "Fines",
  other: "Other",
  private: "Private",
  light_transport: "Light transport",
  heavy: "Heavy",
  motorcycle: "Motorcycle",
  petrol: "Petrol",
  diesel: "Diesel",
  hybrid: "Hybrid",
  electric: "Electric",
  sedan: "Sedan",
  suv: "SUV",
  pickup: "Pickup",
  van: "Van",
  truck: "Truck",
  bus: "Bus",
};

export function statusLabel(code: string): string {
  return STATUS_LABELS[code] ?? code;
}

export const EXPIRY_SOON_DAYS = 30;
export const MAINTENANCE_SOON_DAYS = 7;
export const MAINTENANCE_SOON_KM = 500;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TOKEN_DAYS = 7;
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
/** Fixed sign-in code outside production, so the driver portal can be tried without SMS. */
export const DEMO_OTP = "123456";
/** The only Google account that may sign in as super admin. */
export const SUPER_ADMIN_EMAIL = "ismailthalithanooji@gmail.com";
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;
