import type { NextFunction, Request, Response } from "express";
import type { Role } from "../config/constants";
import { AppError } from "../lib/errors";

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.ctx || !roles.includes(req.ctx.role)) {
      return next(new AppError(403, "FORBIDDEN", "You do not have access to this action"));
    }
    const companyRoute = roles.some((role) => role === "company_admin" || role === "driver");
    if (companyRoute && req.ctx.role === "super_admin" && !req.ctx.companyId) {
      return next(new AppError(403, "SUPPORT_REQUIRED", "Open a support session to view company data"));
    }
    next();
  };
}
