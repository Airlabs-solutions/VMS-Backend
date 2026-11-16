export const MODULES = ["fleet", "equipment", "hr", "payroll"] as const;
export type Module = (typeof MODULES)[number];

export const SUBSCRIPTION_STATUSES = ["trial", "active", "suspended", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_PLANS = ["starter", "professional", "enterprise", "custom"] as const;

export const ROLES = ["super_admin", "company_admin", "fleet_manager", "hr_manager", "payroll_officer", "equipment_manager", "driver"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // Fleet permissions
  "fleet.vehicle.read",
  "fleet.vehicle.write",
  "fleet.maintenance.read",
  "fleet.maintenance.write",
  "fleet.fuel.read",
  "fleet.fuel.write",
  "fleet.violation.read",
  "fleet.violation.write",
  "fleet.trip.read",
  "fleet.trip.write",
  "fleet.expense.read",
  "fleet.expense.write",
  "fleet.assignment.read",
  "fleet.assignment.write",
  "fleet.emi.read",
  "fleet.emi.write",

  // Equipment permissions
  "equipment.asset.read",
  "equipment.asset.write",
  "equipment.inspection.read",
  "equipment.inspection.write",
  "equipment.mobilization.read",
  "equipment.mobilization.write",
  "equipment.operator.read",
  "equipment.operator.write",
  "equipment.cost.read",

  // HR permissions
  "hr.employee.read",
  "hr.employee.write",
  "hr.document.read",
  "hr.document.write",
  "hr.sponsorship.read",
  "hr.sponsorship.write",
  "hr.contract.read",
  "hr.contract.write",
  "hr.salary.read",
  "hr.salary.write",

  // Payroll permissions
  "payroll.run.read",
  "payroll.run.write",
  "payroll.run.approve",
  "payroll.wps.export",
  "payroll.config.read",
  "payroll.config.write",

  // Shared / Compliance / Settings permissions
  "compliance.document.read",
  "compliance.document.write",
  "messaging.read",
  "messaging.write",
  "settings.company.read",
  "settings.company.write",
  "settings.roles.read",
  "settings.roles.write",
  "settings.fields.read",
  "settings.fields.write",
  "reports.read",
  "reports.export",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_DEFAULT_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: PERMISSIONS,
  company_admin: PERMISSIONS,
  fleet_manager: [
    "fleet.vehicle.read",
    "fleet.vehicle.write",
    "fleet.maintenance.read",
    "fleet.maintenance.write",
    "fleet.fuel.read",
    "fleet.fuel.write",
    "fleet.violation.read",
    "fleet.violation.write",
    "fleet.trip.read",
    "fleet.trip.write",
    "fleet.expense.read",
    "fleet.expense.write",
    "fleet.assignment.read",
    "fleet.assignment.write",
    "fleet.emi.read",
    "fleet.emi.write",
    "compliance.document.read",
    "compliance.document.write",
    "messaging.read",
    "messaging.write",
    "reports.read",
    "reports.export",
    "settings.fields.read",
  ],
  hr_manager: [
    "hr.employee.read",
    "hr.employee.write",
    "hr.document.read",
    "hr.document.write",
    "hr.sponsorship.read",
    "hr.sponsorship.write",
    "hr.contract.read",
    "hr.contract.write",
    "compliance.document.read",
    "compliance.document.write",
    "messaging.read",
    "messaging.write",
    "reports.read",
    "reports.export",
    "settings.fields.read",
  ],
  payroll_officer: [
    "hr.employee.read",
    "hr.salary.read",
    "hr.salary.write",
    "payroll.run.read",
    "payroll.run.write",
    "payroll.run.approve",
    "payroll.wps.export",
    "payroll.config.read",
    "payroll.config.write",
    "reports.read",
    "reports.export",
  ],
  equipment_manager: [
    "equipment.asset.read",
    "equipment.asset.write",
    "equipment.inspection.read",
    "equipment.inspection.write",
    "equipment.mobilization.read",
    "equipment.mobilization.write",
    "equipment.operator.read",
    "equipment.operator.write",
    "equipment.cost.read",
    "compliance.document.read",
    "compliance.document.write",
    "messaging.read",
    "messaging.write",
    "reports.read",
    "reports.export",
    "settings.fields.read",
  ],
  driver: [
    "fleet.vehicle.read",
    "fleet.fuel.write",
    "fleet.trip.write",
    "messaging.read",
    "messaging.write",
  ],
};

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
  on_leave: "On leave",
  probation: "Probation",
  terminated: "Terminated",
  under_company: "Under company",
  transfer_pending: "Transfer pending",
  transferred_out: "Transferred out",
  citizen: "Citizen",
  fixed: "Fixed term",
  unlimited: "Unlimited",
  available: "Available",
  mobilized: "Mobilized",
  rented_in: "Rented in",
  rented_out: "Rented out",
  pass: "Pass",
  fail: "Fail",
  planned: "Planned",
  completed: "Completed",
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
/** Primary Google account that may sign in as super admin. */
export const SUPER_ADMIN_EMAIL = process.env.GMAIL_USER || "info@airlabss.com";
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

