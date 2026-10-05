import { Types } from "mongoose";
import { SUPER_ADMIN_EMAIL } from "../../config/constants";
import { encryptField, hmacField } from "../../lib/crypto";
import { AppError, notFound } from "../../lib/errors";
import { getCtx, requireCompanyId } from "../../lib/context";
import { maskMobileLast4, normalizeSaudiMobile } from "../../lib/phone";
import { AuditLog } from "../audit/model";
import { hashPassword } from "../auth/service";
import { User } from "./model";

function userDto(user: {
  _id: unknown;
  name: string;
  email?: string | null;
  role: string;
  status: string;
  mobileLast4?: string | null;
  driverId?: unknown;
  createdAt?: Date;
}) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email ?? null,
    role: user.role,
    status: user.status,
    mobileMasked: user.mobileLast4 ? maskMobileLast4(user.mobileLast4) : null,
    driverId: user.driverId ? String(user.driverId) : null,
    createdAt: user.createdAt,
  };
}

export async function listUsers() {
  const companyId = requireCompanyId();
  const rows = await User.find({ companyId, role: { $in: ["company_admin", "driver"] } })
    .sort({ name: 1 })
    .lean();
  return rows.map(userDto);
}

export async function createCompanyAdmin(input: { name: string; email: string; password: string; mobile: string }) {
  const companyId = requireCompanyId();
  const mobile = normalizeSaudiMobile(input.mobile);
  const existing = await User.findOne({ email: input.email.toLowerCase() });
  if (existing) throw new AppError(409, "DUPLICATE", "An account with this email already exists");
  const user = await User.create({
    companyId,
    role: "company_admin",
    name: input.name.trim(),
    email: input.email.toLowerCase().trim(),
    passwordHash: await hashPassword(input.password),
    mobileEnc: encryptField(mobile),
    mobileHash: hmacField(mobile),
    mobileLast4: mobile.slice(-4),
    status: "active",
  });
  return userDto(user);
}

function gmailDto(user: { _id: unknown; name: string; email?: string | null; status: string }) {
  const email = user.email ?? "";
  return {
    id: String(user._id),
    name: user.name,
    email,
    status: user.status,
    primary: email === SUPER_ADMIN_EMAIL,
  };
}

async function ensurePrimaryGmail() {
  const existing = await User.findOne({ email: SUPER_ADMIN_EMAIL });
  if (existing) return existing;
  return User.create({
    role: "super_admin",
    name: "Platform Admin",
    email: SUPER_ADMIN_EMAIL,
    status: "active",
  });
}

async function writeGmailAudit(action: "create" | "update" | "delete", docId: string, status?: string) {
  const ctx = getCtx();
  await AuditLog.create({
    actorId: ctx.userId ? new Types.ObjectId(ctx.userId) : undefined,
    action,
    collectionName: "users",
    docId,
    after: status ? { role: "super_admin", status } : undefined,
    at: new Date(),
    ip: ctx.ip,
    supportGrantId: ctx.supportGrantId,
  });
}

const platformAdmin = { role: "super_admin", $or: [{ companyId: null }, { companyId: { $exists: false } }] };

export async function listGmailAccess() {
  await ensurePrimaryGmail();
  const rows = await User.find(platformAdmin).sort({ createdAt: 1 }).lean();
  return rows.map(gmailDto);
}

export async function createGmailAccess(input: { name: string; email: string }) {
  const email = input.email.trim().toLowerCase();
  const existing = await User.findOne({ email });
  if (existing) throw new AppError(409, "DUPLICATE", "An account with this email already exists");
  const user = await User.create({
    role: "super_admin",
    name: input.name.trim(),
    email,
    status: "active",
  });
  await writeGmailAudit("create", String(user._id), "active");
  return gmailDto(user);
}

export async function updateGmailAccess(id: string, input: { name?: string; email?: string; status?: "active" | "inactive" }) {
  const user = await User.findOne({ _id: id, ...platformAdmin });
  if (!user) throw notFound("User");
  const primary = user.email === SUPER_ADMIN_EMAIL;
  const nextEmail = input.email?.trim().toLowerCase();
  if (primary && nextEmail && nextEmail !== SUPER_ADMIN_EMAIL) {
    throw new AppError(400, "INVALID", "The primary Gmail address cannot be changed");
  }
  if (primary && input.status === "inactive") {
    throw new AppError(400, "INVALID", "The primary Gmail address stays active");
  }
  if (getCtx().userId === id && input.status === "inactive") {
    throw new AppError(400, "INVALID", "You cannot change your own status");
  }
  if (nextEmail && nextEmail !== user.email) {
    const clash = await User.findOne({ email: nextEmail, _id: { $ne: user._id } });
    if (clash) throw new AppError(409, "DUPLICATE", "An account with this email already exists");
    user.email = nextEmail;
  }
  if (input.name?.trim()) user.name = input.name.trim();
  if (input.status) user.status = input.status;
  await user.save();
  await writeGmailAudit("update", String(user._id), user.status);
  return gmailDto(user);
}

export async function deleteGmailAccess(id: string) {
  const user = await User.findOne({ _id: id, ...platformAdmin });
  if (!user) throw notFound("User");
  if (user.email === SUPER_ADMIN_EMAIL) throw new AppError(400, "INVALID", "The primary Gmail address cannot be removed");
  if (getCtx().userId === id) throw new AppError(400, "INVALID", "You cannot remove your own access");
  await user.deleteOne();
  await writeGmailAudit("delete", id);
  return { id };
}

export async function updateUserStatus(id: string, status: "active" | "inactive") {
  const companyId = requireCompanyId();
  const actor = getCtx().userId;
  if (actor === id) throw new AppError(400, "INVALID", "You cannot change your own status");
  const user = await User.findOneAndUpdate({ _id: id, companyId }, { status }, { new: true });
  if (!user) throw notFound("User");
  return userDto(user);
}
