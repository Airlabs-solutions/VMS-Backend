import { Types } from "mongoose";
import { z } from "zod";
import { ALERT_DEFAULTS, ALERT_TYPES, MODULES, SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUSES, type Module } from "../../config/constants";
import { requestContext } from "../../lib/context";
import { encryptField, hmacField } from "../../lib/crypto";
import { AppError, notFound } from "../../lib/errors";
import { assertMobileAvailable } from "../../lib/mobileUnique";
import { normalizeSaudiMobile } from "../../lib/phone";
import { invalidateEntitlementCache } from "../../middleware/requireModule";
import { validateLimitDowngrade } from "../../core/tenant/limits";
import { hashPassword } from "../auth/service";
import { AlertRule } from "../alerts/model";
import { User } from "../users/model";
import { Company, PlatformAuditLog } from "./model";
import { SupportGrant } from "./supportGrant";

async function seedAlertRules(companyId: string) {
  const parent = requestContext.getStore() ?? {};
  await requestContext.run({ ...parent, companyId, skipTenant: false, internal: false }, async () => {
    for (const type of ALERT_TYPES) {
      const defaults = ALERT_DEFAULTS[type];
      const existing = await AlertRule.findOne({ type });
      if (!existing) {
        await AlertRule.create({
          type,
          offsets: defaults.offsets,
          enabled: true,
          recipients: defaults.recipients,
        });
      }
    }
  });
}

export function companyDto(company: any) {
  const vehiclesLimit = company.limits?.vehicles ?? company.maxVehicles ?? 500;
  const credits = company.limits?.smsCredits ?? company.smsCredits ?? 0;

  return {
    id: String(company._id),
    name: company.name,
    status: company.status,
    modules: company.modules && company.modules.length > 0 ? (company.modules as string[]) : ["fleet"],
    limits: {
      vehicles: vehiclesLimit,
      equipment: company.limits?.equipment ?? 0,
      employees: company.limits?.employees ?? 0,
      adminSeats: company.limits?.adminSeats ?? 5,
      smsCredits: credits,
      storageMb: company.limits?.storageMb ?? 5120,
    },
    subscription: {
      plan: company.subscription?.plan ?? company.plan ?? "starter",
      status: company.subscription?.status ?? company.status ?? "active",
      startsAt: company.subscription?.startsAt ?? company.createdAt ?? new Date(),
      endsAt: company.subscription?.endsAt ?? null,
      notes: company.subscription?.notes ?? "",
    },
    plan: company.plan ?? "standard",
    maxVehicles: vehiclesLimit,
    smsSenderName: company.smsSenderName ?? "AxetPro",
    smsCredits: credits,
    driverPasswordLogin: company.driverPasswordLogin ?? false,
    createdAt: company.createdAt,
  };
}

export async function listCompanies() {
  const rows = await Company.find().sort({ name: 1 }).lean();
  return rows.map(companyDto);
}

export async function createCompany(input: {
  name: string;
  modules?: Module[];
  limits?: Partial<{
    vehicles: number;
    equipment: number;
    employees: number;
    adminSeats: number;
    smsCredits: number;
    storageMb: number;
  }>;
  subscription?: Partial<{
    plan: string;
    status: "trial" | "active" | "suspended" | "expired";
    startsAt: Date;
    endsAt?: Date;
    notes: string;
  }>;
  plan?: string;
  maxVehicles?: number;
  smsSenderName?: string;
  smsCredits?: number;
  admin: { name: string; email: string; password: string; mobile: string };
}) {
  const mobile = normalizeSaudiMobile(input.admin.mobile);
  await assertMobileAvailable(mobile);

  const initialVehicles = input.limits?.vehicles ?? input.maxVehicles ?? 500;
  const initialCredits = input.limits?.smsCredits ?? input.smsCredits ?? 0;

  const company = await Company.create({
    name: input.name.trim(),
    modules: input.modules && input.modules.length > 0 ? input.modules : ["fleet"],
    limits: {
      vehicles: initialVehicles,
      equipment: input.limits?.equipment ?? 0,
      employees: input.limits?.employees ?? 0,
      adminSeats: input.limits?.adminSeats ?? 5,
      smsCredits: initialCredits,
      storageMb: input.limits?.storageMb ?? 5120,
    },
    subscription: {
      plan: input.subscription?.plan ?? input.plan ?? "starter",
      status: input.subscription?.status ?? "active",
      startsAt: input.subscription?.startsAt ?? new Date(),
      endsAt: input.subscription?.endsAt,
      notes: input.subscription?.notes ?? "",
    },
    plan: input.plan?.trim() || "standard",
    maxVehicles: initialVehicles,
    smsSenderName: input.smsSenderName?.trim() || "AxetPro",
    smsCredits: initialCredits,
    status: "active",
  });

  await User.create({
    companyId: company._id,
    role: "company_admin",
    name: input.admin.name.trim(),
    email: input.admin.email.toLowerCase().trim(),
    passwordHash: await hashPassword(input.admin.password),
    mobileEnc: encryptField(mobile),
    mobileHash: hmacField(mobile),
    mobileLast4: mobile.slice(-4),
    status: "active",
  });

  await seedAlertRules(String(company._id));
  return companyDto(company);
}

export async function updateCompany(
  id: string,
  input: Partial<{
    name: string;
    status: "active" | "suspended";
    modules: Module[];
    limits: {
      vehicles?: number;
      equipment?: number;
      employees?: number;
      adminSeats?: number;
      smsCredits?: number;
      storageMb?: number;
    };
    subscription: {
      plan?: string;
      status?: "trial" | "active" | "suspended" | "expired";
      startsAt?: Date;
      endsAt?: Date;
      notes?: string;
    };
    plan: string;
    maxVehicles: number;
    smsSenderName: string;
    smsCredits: number;
    driverPasswordLogin: boolean;
    confirmDowngrade: boolean;
  }>,
  actor?: { id: string; email: string },
) {
  const current = await Company.findById(id);
  if (!current) throw notFound("Company");

  const before = current.toObject();

  if (input.limits?.vehicles !== undefined || input.maxVehicles !== undefined) {
    const targetVehicles = input.limits?.vehicles ?? input.maxVehicles;
    await validateLimitDowngrade(id, targetVehicles, input.confirmDowngrade);
  }

  if (input.name) current.name = input.name.trim();
  if (input.status) current.status = input.status;
  if (input.modules) {
    current.modules = input.modules as any;
    invalidateEntitlementCache(id);
  }
  if (input.limits) {
    current.limits = {
      vehicles: input.limits.vehicles ?? current.limits?.vehicles ?? 500,
      equipment: input.limits.equipment ?? current.limits?.equipment ?? 0,
      employees: input.limits.employees ?? current.limits?.employees ?? 0,
      adminSeats: input.limits.adminSeats ?? current.limits?.adminSeats ?? 5,
      smsCredits: input.limits.smsCredits ?? current.limits?.smsCredits ?? 0,
      storageMb: input.limits.storageMb ?? current.limits?.storageMb ?? 5120,
    };
    current.maxVehicles = current.limits.vehicles;
    current.smsCredits = current.limits.smsCredits;
  }
  if (input.maxVehicles !== undefined && !input.limits?.vehicles) {
    current.maxVehicles = input.maxVehicles;
    if (current.limits) current.limits.vehicles = input.maxVehicles;
  }
  if (input.smsCredits !== undefined && !input.limits?.smsCredits) {
    current.smsCredits = input.smsCredits;
    if (current.limits) current.limits.smsCredits = input.smsCredits;
  }
  if (input.subscription) {
    current.subscription = {
      plan: (input.subscription.plan ?? current.subscription?.plan ?? "starter") as "starter" | "professional" | "enterprise" | "custom",
      status: (input.subscription.status ?? current.subscription?.status ?? "active") as "trial" | "active" | "suspended" | "expired",
      startsAt: input.subscription.startsAt ?? current.subscription?.startsAt ?? new Date(),
      endsAt: input.subscription.endsAt ?? current.subscription?.endsAt,
      notes: input.subscription.notes ?? current.subscription?.notes ?? "",
    };
  }
  if (input.smsSenderName !== undefined) current.smsSenderName = input.smsSenderName.trim();
  if (input.driverPasswordLogin !== undefined) current.driverPasswordLogin = input.driverPasswordLogin;

  await current.save();

  if (actor) {
    await PlatformAuditLog.create({
      actorId: actor.id,
      actorEmail: actor.email,
      targetCompanyId: id,
      action: "company.settings.update",
      before,
      after: current.toObject(),
    }).catch(() => {});
  }

  return companyDto(current);
}

export async function listCompanyAuditLogs(companyId: string) {
  const rows = await PlatformAuditLog.find({ targetCompanyId: companyId }).sort({ timestamp: -1 }).limit(100).lean();
  return rows.map((r) => ({
    id: String(r._id),
    actorEmail: r.actorEmail,
    action: r.action,
    before: r.before,
    after: r.after,
    timestamp: r.timestamp,
  }));
}

export async function getOwnCompany() {
  const { requireCompanyId } = await import("../../lib/context");
  const company = await Company.findById(requireCompanyId()).lean();
  if (!company) throw notFound("Company");
  return companyDto(company);
}

export async function updateOwnCompany(input: { name?: string; smsSenderName?: string; driverPasswordLogin?: boolean }) {
  const { requireCompanyId } = await import("../../lib/context");
  return updateCompany(requireCompanyId(), input);
}

export async function grantSupport(reason: string, hours: number) {
  const { requireCompanyId, getCtx } = await import("../../lib/context");
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  const grant = await SupportGrant.create({
    grantedBy: getCtx().userId,
    reason,
    expiresAt,
  });
  return { id: String(grant._id), reason, expiresAt, companyId: requireCompanyId() };
}

export async function listSupportGrants() {
  const parent = requestContext.getStore() ?? {};
  return requestContext.run({ ...parent, skipTenant: true, internal: true }, async () => {
    const grants = await SupportGrant.find({ revokedAt: null, expiresAt: { $gt: new Date() } })
      .sort({ expiresAt: 1 })
      .lean<Array<{ _id: unknown; companyId: unknown; reason: string; expiresAt: Date }>>();
    const companies = await Company.find({ _id: { $in: grants.map((grant) => grant.companyId) } }).lean();
    const names = new Map(companies.map((company) => [String(company._id), company.name]));
    return grants.map((grant) => ({
      id: String(grant._id),
      companyId: String(grant.companyId),
      companyName: names.get(String(grant.companyId)) ?? "",
      reason: grant.reason,
      expiresAt: grant.expiresAt,
    }));
  });
}

export async function openFleet(res: import("express").Response) {
  const { getCtx } = await import("../../lib/context");
  const user = await User.findById(getCtx().userId);
  if (!user || user.role !== "super_admin") throw new AppError(403, "FORBIDDEN", "You do not have access to this action");
  const company = await Company.findOne({ status: "active" }).sort({ createdAt: 1 });
  if (!company) throw new AppError(404, "NO_COMPANY", "No company is available");
  const parent = requestContext.getStore() ?? {};
  const grant = await requestContext.run({ ...parent, skipTenant: true, internal: true, userId: String(user._id) }, () =>
    SupportGrant.create({
      companyId: company._id,
      grantedBy: user._id,
      reason: "Fleet admin access",
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    }),
  );
  const { enterSupport } = await import("../auth/service");
  return enterSupport(user, String(company._id), String(grant._id), res);
}

export async function enterSupportGrant(grantId: string, res: import("express").Response) {
  const { getCtx } = await import("../../lib/context");
  const parent = requestContext.getStore() ?? {};
  const grant = await requestContext.run({ ...parent, skipTenant: true, internal: true }, () =>
    SupportGrant.findById(grantId).lean<{ _id: unknown; companyId: unknown; revokedAt?: Date | null; expiresAt: Date } | null>(),
  );
  if (!grant || grant.revokedAt || grant.expiresAt.getTime() < Date.now()) {
    throw new AppError(403, "SUPPORT_EXPIRED", "Support access has expired");
  }
  const user = await User.findById(getCtx().userId);
  if (!user || user.role !== "super_admin") throw new AppError(403, "FORBIDDEN", "You do not have access to this action");
  const { enterSupport } = await import("../auth/service");
  return enterSupport(user, String(grant.companyId), String(grant._id), res);
}

export const companyAdminSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).regex(/[A-Za-z]/).regex(/\d/),
  mobile: z.string().trim().min(7).max(24),
});

export function assertObjectId(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "VALIDATION_ERROR", "Invalid id");
}
