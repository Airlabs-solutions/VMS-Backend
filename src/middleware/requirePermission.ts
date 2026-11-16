import type { NextFunction, Request, Response } from "express";
import type { Permission } from "../config/constants";
import { hasPermission, resolveUserPermissions } from "../core/auth/permissions";
import { AppError } from "../lib/errors";
import { AuditLog } from "../modules/audit/model";

export function requirePermission(...requiredPermissions: Permission[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.ctx) {
        throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
      }

      // Super admin has unrestricted administrative access
      if (req.ctx.role === "super_admin") {
        return next();
      }

      const permissions = await resolveUserPermissions(
        req.ctx.role,
        req.ctx.companyId ?? undefined,
      );

      const isAllowed = hasPermission(permissions, requiredPermissions);
      if (!isAllowed) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "You do not have the required permission to perform this action.",
        );
      }

      // Audit sensitive reads (e.g. salary inspections)
      if (requiredPermissions.includes("hr.salary.read") && req.ctx.companyId) {
        await AuditLog.create({
          companyId: req.ctx.companyId,
          action: "READ",
          collectionName: "SalaryStructure",
          docId: req.params.id || "list",
          actorId: req.ctx.userId,
          at: new Date(),
        }).catch(() => {
          // Non-blocking background log
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
