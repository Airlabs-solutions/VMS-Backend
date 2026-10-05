import { randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import { DEMO_OTP, LOGIN_LOCK_MS, LOGIN_MAX_FAILURES, OTP_MAX_ATTEMPTS, OTP_TTL_MS, REFRESH_TOKEN_DAYS, SUPER_ADMIN_EMAIL } from "../../config/constants";
import { env } from "../../config/env";
import { appKindFromRole, clearAuthCookies, readSessionCookies, setAuthCookies, signAccessToken, type AccessPayload } from "../../lib/cookies";
import { requestContext } from "../../lib/context";
import { encryptField, hmacField, randomToken, sha256 } from "../../lib/crypto";
import { isDuplicateKey } from "../../lib/tenantPlugin";
import { AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { maskMobile, normalizeSaudiMobile } from "../../lib/phone";
import { Company } from "../companies/model";
import { Driver } from "../drivers/model";
import { User } from "../users/model";
import { OtpRequest, RefreshToken } from "./model";
import { sendSuperAdminCode } from "../../integrations/email/gmail";
import { verifySuperAdminGoogle } from "../../integrations/google/verify";
import { getSmsProvider } from "../../integrations/sms";

const GENERIC_LOGIN = "Email or password is incorrect";
const GENERIC_OTP = "If this number is registered, a code was sent";

function publicUser(user: {
  _id: unknown;
  name: string;
  email?: string | null;
  role: string;
  companyId?: unknown;
  driverId?: unknown;
  status: string;
}) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email ?? null,
    role: user.role,
    companyId: user.companyId ? String(user.companyId) : null,
    driverId: user.driverId ? String(user.driverId) : null,
    status: user.status,
  };
}

type SessionUser = {
  _id: unknown;
  name: string;
  email?: string | null;
  role: "super_admin" | "company_admin" | "driver";
  companyId?: unknown;
  driverId?: unknown;
  status: string;
};

async function issueSession(
  user: SessionUser,
  res: Response,
  extras?: { supportGrantId?: string; companyId?: string },
) {
  const payload: AccessPayload = {
    sub: String(user._id),
    role: user.role,
    companyId: extras?.companyId ?? (user.companyId ? String(user.companyId) : null),
    driverId: user.driverId ? String(user.driverId) : null,
    supportGrantId: extras?.supportGrantId ?? null,
  };
  const access = signAccessToken(payload);
  const refresh = randomToken(48);
  const csrf = randomToken(24);
  await RefreshToken.create({
    userId: user._id,
    tokenHash: sha256(refresh),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
  });
  setAuthCookies(res, access, refresh, csrf, appKindFromRole(user.role));
  return {
    ...publicUser(user),
    companyId: payload.companyId,
    csrfToken: csrf,
    supportGrantId: payload.supportGrantId,
  };
}

export async function enterSupport(user: SessionUser, companyId: string, supportGrantId: string, res: Response) {
  return issueSession(user, res, { companyId, supportGrantId });
}

export async function login(email: string, password: string, res: Response) {
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user || !user.passwordHash || user.role === "super_admin") throw new AppError(401, "INVALID_LOGIN", GENERIC_LOGIN);
  if (user.status !== "active") throw new AppError(403, "INACTIVE", "This account is inactive");
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new AppError(423, "LOCKED", "Too many attempts. Try again later.");
  }
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    user.failedLoginCount += 1;
    if (user.failedLoginCount >= LOGIN_MAX_FAILURES) {
      user.lockedUntil = new Date(Date.now() + LOGIN_LOCK_MS);
      user.failedLoginCount = 0;
    }
    await user.save();
    throw new AppError(401, "INVALID_LOGIN", GENERIC_LOGIN);
  }
  if (user.companyId) {
    const company = await Company.findById(user.companyId).lean();
    if (!company || company.status !== "active") {
      throw new AppError(403, "COMPANY_SUSPENDED", "This company is suspended");
    }
    if (user.role === "driver" && !company.driverPasswordLogin) {
      throw new AppError(403, "OTP_REQUIRED", "Drivers sign in with a mobile code");
    }
  }
  user.failedLoginCount = 0;
  user.lockedUntil = undefined;
  await user.save();
  const data = await issueSession(user, res);
  return data;
}

export async function refresh(req: Request, res: Response) {
  const session = readSessionCookies(req);
  if (!session.refresh) throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
  const tokenHash = sha256(session.refresh);
  const stored = await RefreshToken.findOne({ tokenHash });
  if (!stored) throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
  if (stored.revokedAt) {
    await RefreshToken.updateMany({ userId: stored.userId, revokedAt: null }, { revokedAt: new Date() });
    throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
  }
  if (stored.expiresAt.getTime() < Date.now()) throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
  const user = await User.findById(stored.userId);
  if (!user || user.status !== "active") throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
  if (appKindFromRole(user.role) !== session.kind) {
    throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
  }
  stored.revokedAt = new Date();
  await stored.save();
  clearAuthCookies(res, session.kind, session.legacy);
  return issueSession(user, res);
}

export async function logout(req: Request, res: Response) {
  const session = readSessionCookies(req);
  if (session.refresh) {
    await RefreshToken.updateOne({ tokenHash: sha256(session.refresh) }, { revokedAt: new Date() });
  }
  clearAuthCookies(res, session.kind, session.legacy);
}

export async function requestOtp(mobileRaw: string) {
  let mobile: string;
  try {
    mobile = normalizeSaudiMobile(mobileRaw);
  } catch {
    return { message: GENERIC_OTP };
  }
  const mobileHash = hmacField(mobile);
  const recent = await OtpRequest.countDocuments({
    mobileHash,
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  });
  if (env.isProduction && recent >= 5) throw new AppError(429, "RATE_LIMIT", "Too many attempts. Try again later.");

  const user = await User.findOne({ mobileHash, role: "driver", status: "active" });
  const company = user?.companyId ? await Company.findById(user.companyId).lean() : null;
  const canSend = Boolean(user && company && company.status === "active");
  if (env.isProduction && !canSend) return { message: GENERIC_OTP };

  const code = env.isProduction ? String(randomInt(100000, 1000000)) : DEMO_OTP;
  await OtpRequest.create({
    mobileHash,
    codeHash: hmacField(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    attempts: 0,
  });
  if (canSend && company) {
    const body = `Your VMS sign-in code is ${code}. It expires in 5 minutes.`;
    try {
      await getSmsProvider().send({ to: mobile, body, sender: company.smsSenderName || env.SMS_SENDER });
    } catch (error) {
      logger.error({ message: error instanceof Error ? error.message : "sms failed" }, "OTP send failed");
    }
  }
  if (!env.isProduction) {
    logger.info({ to: maskMobile(mobile), devCode: code }, "OTP issued");
    return { message: GENERIC_OTP, devCode: code };
  }
  return { message: GENERIC_OTP };
}

/** Development only: the fixed demo code opens the portal for the mobile number entered. */
async function driverForDemoLogin(mobile: string) {
  const mobileHash = hmacField(mobile);
  const existing = await User.findOne({ mobileHash, role: "driver", status: "active" });
  if (existing) {
    const company = await Company.findById(existing.companyId).lean();
    if (!company || company.status !== "active") {
      throw new AppError(403, "COMPANY_SUSPENDED", "This company is suspended");
    }
    return existing;
  }

  let company = await Company.findOne({ status: "active" }).sort({ createdAt: 1 });
  if (!company) {
    company = await Company.create({
      name: "Fleet",
      status: "active",
      plan: "standard",
      maxVehicles: 500,
      smsSenderName: "VMS",
      smsCredits: 0,
      driverPasswordLogin: false,
    });
  }

  const digits = mobile.replace(/\D/g, "");
  const iqama = `2${digits.slice(-9).padStart(9, "0")}`;
  const license = `D${digits.slice(-9).padStart(9, "0")}`;
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);

  try {
    return await requestContext.run({ companyId: String(company._id) }, async () => {
      const driver = await Driver.create({
        name: "Demo Driver",
        mobileEnc: encryptField(mobile),
        mobileHash,
        mobileLast4: mobile.slice(-4),
        iqamaEnc: encryptField(iqama),
        iqamaHash: hmacField(iqama),
        iqamaExpiry: expiry,
        licenseNumberEnc: encryptField(license),
        licenseType: "private",
        licenseExpiry: expiry,
        status: "active",
      });
      return User.create({
        companyId: company._id,
        role: "driver",
        name: "Demo Driver",
        mobileEnc: encryptField(mobile),
        mobileHash,
        mobileLast4: mobile.slice(-4),
        driverId: driver._id,
        status: "active",
      });
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const again = await User.findOne({ mobileHash, role: "driver", status: "active" });
    if (!again) throw new AppError(401, "INVALID_OTP", "The code is incorrect or expired");
    return again;
  }
}

export async function verifyOtp(mobileRaw: string, code: string, res: Response) {
  const mobile = normalizeSaudiMobile(mobileRaw);
  const mobileHash = hmacField(mobile);
  if (!env.isProduction && code.trim() === DEMO_OTP) {
    const user = await driverForDemoLogin(mobile);
    await OtpRequest.deleteMany({ mobileHash });
    return issueSession(user, res);
  }
  const otp = await OtpRequest.findOne({ mobileHash, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  if (!otp) throw new AppError(401, "INVALID_OTP", "The code is incorrect or expired");
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new AppError(401, "INVALID_OTP", "The code is incorrect or expired");
  if (otp.codeHash !== hmacField(code.trim())) {
    otp.attempts += 1;
    await otp.save();
    throw new AppError(401, "INVALID_OTP", "The code is incorrect or expired");
  }
  const user = await User.findOne({ mobileHash, role: "driver", status: "active" });
  if (!user) throw new AppError(401, "INVALID_OTP", "The code is incorrect or expired");
  await otp.deleteOne();
  return issueSession(user, res);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

const SUPER_ADMIN_OTP = "A sign-in code was sent to the Super Admin Gmail.";

async function ensureSuperAdmin(name: string) {
  let user = await User.findOne({ email: SUPER_ADMIN_EMAIL });
  if (user && user.role !== "super_admin") {
    throw new AppError(403, "GOOGLE_NOT_ALLOWED", "This Google account is not allowed");
  }
  if (!user) {
    user = await User.create({
      role: "super_admin",
      name,
      email: SUPER_ADMIN_EMAIL,
      status: "active",
    });
    return user;
  }
  if (user.status !== "active") throw new AppError(403, "INACTIVE", "This account is inactive");
  await User.updateOne(
    { _id: user._id },
    { $set: { name, role: "super_admin", status: "active" }, $unset: { passwordHash: "" } },
  );
  user.name = name;
  user.passwordHash = undefined;
  return user;
}

export function superAdminAuthConfig() {
  return {
    email: SUPER_ADMIN_EMAIL,
    googleClientId: env.GOOGLE_CLIENT_ID ?? null,
  };
}

export async function signInSuperAdminWithGoogle(credential: string, res: Response) {
  const google = await verifySuperAdminGoogle(credential);
  if (google.email === SUPER_ADMIN_EMAIL) {
    const user = await ensureSuperAdmin(google.name);
    return issueSession(user, res);
  }
  const user = await User.findOne({ email: google.email, role: "super_admin", status: "active" });
  if (!user) throw new AppError(403, "GOOGLE_NOT_ALLOWED", "This Google account is not allowed");
  return issueSession(user, res);
}

export async function requestSuperAdminCode(emailInput?: string) {
  const email = emailInput?.trim().toLowerCase() || SUPER_ADMIN_EMAIL;
  if (email === SUPER_ADMIN_EMAIL) {
    await ensureSuperAdmin("Platform Admin");
  } else {
    const allowed = await User.findOne({ email, role: "super_admin", status: "active" });
    if (!allowed) throw new AppError(403, "NOT_ALLOWED", "This email cannot be used to sign in.");
  }
  const emailHash = hmacField(email);
  const recent = await OtpRequest.countDocuments({
    emailHash,
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  });
  if (env.isProduction && recent >= 5) throw new AppError(429, "RATE_LIMIT", "Too many attempts. Try again later.");

  const code = String(randomInt(100000, 1000000));
  await OtpRequest.deleteMany({ emailHash });
  await OtpRequest.create({
    emailHash,
    codeHash: hmacField(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    attempts: 0,
  });

  try {
    const delivered = await sendSuperAdminCode(code);
    if (!delivered) {
      logger.info({ devCode: code }, "Super admin OTP issued");
      return { message: "Gmail is not configured, so the development code is shown below.", devCode: code };
    }
  } catch (error) {
    await OtpRequest.deleteMany({ emailHash });
    throw error;
  }
  return { message: SUPER_ADMIN_OTP };
}

export async function verifySuperAdminCode(code: string, res: Response, emailInput?: string) {
  const email = emailInput?.trim().toLowerCase() || SUPER_ADMIN_EMAIL;
  const emailHash = hmacField(email);
  const otp = await OtpRequest.findOne({ emailHash, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  if (!otp) throw new AppError(401, "INVALID_OTP", "The code is incorrect or expired");
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new AppError(401, "INVALID_OTP", "The code is incorrect or expired");
  if (otp.codeHash !== hmacField(code.trim())) {
    otp.attempts += 1;
    await otp.save();
    throw new AppError(401, "INVALID_OTP", "The code is incorrect or expired");
  }
  const user = await User.findOne({ email, role: "super_admin", status: "active" });
  if (!user) throw new AppError(401, "INVALID_OTP", "The code is incorrect or expired");
  await otp.deleteOne();
  return issueSession(user, res);
}
