import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors";
import { getCtx } from "../lib/context";
import { appKindFromRole, readSessionCookies, verifyAccessToken } from "../lib/cookies";
import { Company } from "../modules/companies/model";
import { SupportGrant } from "../modules/companies/supportGrant";

type GrantLean = {
  companyId: { toString(): string };
  revokedAt?: Date | null;
  expiresAt: Date;
};

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const session = readSessionCookies(req);
    if (!session.access) throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");

    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const header = req.get("x-csrf-token");
      if (!session.csrf || !header || session.csrf !== header) {
        throw new AppError(403, "CSRF", "Refresh the page and try again");
      }
    }

    const payload = verifyAccessToken(session.access);
    if (appKindFromRole(payload.role) !== session.kind) {
      throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
    }
    const store = getCtx();
    store.userId = payload.sub;
    store.role = payload.role;
    store.driverId = payload.driverId;

    if (payload.supportGrantId) {
      store.internal = true;
      store.skipTenant = true;
      const grant = await SupportGrant.findById(payload.supportGrantId).lean<GrantLean | null>();
      store.internal = false;
      store.skipTenant = false;
      if (!grant || grant.revokedAt || grant.expiresAt.getTime() < Date.now()) {
        throw new AppError(403, "SUPPORT_EXPIRED", "Support access has expired");
      }
      store.companyId = String(grant.companyId);
      store.supportGrantId = payload.supportGrantId;
    } else if (payload.role === "super_admin") {
      store.skipTenant = true;
      store.internal = true;
      const company = await Company.findOne({ status: "active" }).sort({ createdAt: 1 }).select("_id").lean();
      store.internal = false;
      store.supportGrantId = null;
      if (company) {
        store.companyId = String(company._id);
        store.skipTenant = false;
      } else {
        store.companyId = null;
        store.skipTenant = true;
      }
    } else {
      if (!payload.companyId) throw new AppError(403, "FORBIDDEN", "Missing company");
      store.companyId = payload.companyId;
      store.skipTenant = false;
      store.supportGrantId = null;
    }

    req.ctx = {
      userId: payload.sub,
      role: payload.role,
      companyId: store.companyId ?? null,
      driverId: payload.driverId,
      supportGrantId: store.supportGrantId ?? null,
    };
    next();
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(new AppError(401, "UNAUTHENTICATED", "Sign in to continue"));
  }
}
