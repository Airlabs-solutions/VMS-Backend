import type { NextFunction, Request, Response } from "express";
import type { Module } from "../config/constants";
import { AppError } from "../lib/errors";
import { Company } from "../modules/companies/model";

interface CachedEntitlements {
  modules: string[];
  expiresAt: number;
}

const entitlementCache = new Map<string, CachedEntitlements>();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

export function invalidateEntitlementCache(companyId?: string) {
  if (companyId) {
    entitlementCache.delete(companyId);
  } else {
    entitlementCache.clear();
  }
}

export function requireModule(moduleName: Module) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.ctx) {
        throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
      }

      // Platform super admin can access all modules in platform management contexts
      if (req.ctx.role === "super_admin" && !req.ctx.companyId) {
        return next();
      }

      const companyId = req.ctx.companyId;
      if (!companyId) {
        throw new AppError(403, "FORBIDDEN", "No company context active");
      }

      const now = Date.now();
      let cached = entitlementCache.get(companyId);
      if (!cached || cached.expiresAt <= now) {
        const company = await Company.findById(companyId).select("modules status").lean();
        if (!company) {
          throw new AppError(404, "NOT_FOUND", "Company was not found");
        }
        if (company.status === "suspended") {
          throw new AppError(403, "COMPANY_SUSPENDED", "Company account is suspended");
        }

        cached = {
          modules: company.modules && company.modules.length > 0 ? company.modules : ["fleet"],
          expiresAt: now + CACHE_TTL_MS,
        };
        entitlementCache.set(companyId, cached);
      }

      if (!cached.modules.includes(moduleName)) {
        throw new AppError(
          403,
          "MODULE_NOT_ENABLED",
          `The ${moduleName} module is not enabled for your company. Contact your account manager to activate it.`,
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
