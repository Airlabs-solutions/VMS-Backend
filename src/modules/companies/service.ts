import { Types } from "mongoose";
import { z } from "zod";
import { ALERT_DEFAULTS, ALERT_TYPES } from "../../config/constants";
import { requestContext } from "../../lib/context";
import { encryptField, hmacField } from "../../lib/crypto";
import { AppError, notFound } from "../../lib/errors";
import { normalizeSaudiMobile } from "../../lib/phone";
import { hashPassword } from "../auth/service";
import { AlertRule } from "../alerts/model";
import { User } from "../users/model";
import { Company } from "./model";
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

function companyDto(company: {
  _id: unknown;
  name: string;
  status: string;
  plan: string;
  maxVehicles: number;
  smsSenderName: string;
  smsCredits: number;
  driverPasswordLogin: boolean;
  createdAt?: Date;
}) {
  return {
    id: String(company._id),
    name: company.name,
    status: company.status,
    plan: company.plan,
    maxVehicles: company.maxVehicles,
    smsSenderName: company.smsSenderName,
    smsCredits: company.smsCredits,
    driverPasswordLogin: company.driverPasswordLogin,
    createdAt: company.createdAt,
  };
}

export async function listCompanies() {
  const rows = await Company.find().sort({ name: 1 }).lean();
  return rows.map(companyDto);
}

export async function createCompany(input: {
  name: string;
  plan?: string;
  maxVehicles: number;
  smsSenderName?: string;
  smsCredits?: number;
  admin: { name: string; email: string; password: string; mobile: string };
}) {
  const mobile = normalizeSaudiMobile(input.admin.mobile);
  const company = await Company.create({
    name: input.name.trim(),
    plan: input.plan?.trim() || "standard",
    maxVehicles: input.maxVehicles,
    smsSenderName: input.smsSenderName?.trim() || "VMS",
    smsCredits: input.smsCredits ?? 0,
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
    plan: string;
    maxVehicles: number;
    smsSenderName: string;
    smsCredits: number;
    driverPasswordLogin: boolean;
  }>,
) {
  const company = await Company.findByIdAndUpdate(id, input, { new: true });
  if (!company) throw notFound("Company");
  return companyDto(company);
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
