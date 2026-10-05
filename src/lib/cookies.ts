import type { CookieOptions, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { ACCESS_TOKEN_TTL, REFRESH_TOKEN_DAYS, type Role } from "../config/constants";
import { env } from "../config/env";

export type AccessPayload = {
  sub: string;
  role: Role;
  companyId: string | null;
  driverId: string | null;
  supportGrantId: string | null;
};

const cookieBase: CookieOptions = {
  secure: env.COOKIE_SECURE,
  sameSite: "lax",
};

export function signAccessToken(payload: AccessPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string): AccessPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
}

export type AppKind = "admin" | "driver";

const cookieNames = {
  admin: { access: "vms_admin_access", refresh: "vms_admin_refresh", csrf: "vms_admin_csrf" },
  driver: { access: "vms_driver_access", refresh: "vms_driver_refresh", csrf: "vms_driver_csrf" },
} as const;

const legacyNames = { access: "vms_access", refresh: "vms_refresh", csrf: "vms_csrf" };

export function appKindFromRole(role: Role): AppKind {
  return role === "driver" ? "driver" : "admin";
}

export function appKindFromRequest(req: Request): AppKind {
  const header = req.get("x-vms-app");
  if (header === "driver" || header === "admin") return header;
  const origin = `${req.get("origin") ?? ""} ${req.get("referer") ?? ""}`;
  if (/:3000\b/.test(origin)) return "driver";
  return "admin";
}

function cookieValue(req: Request, name: string) {
  const value = req.cookies?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readSessionCookies(req: Request) {
  const kind = appKindFromRequest(req);
  const names = cookieNames[kind];
  const access = cookieValue(req, names.access);
  const refresh = cookieValue(req, names.refresh);
  const csrf = cookieValue(req, names.csrf);
  if (access || refresh) return { kind, access, refresh, csrf, legacy: false };

  const legacyAccess = cookieValue(req, legacyNames.access);
  const legacyRefresh = cookieValue(req, legacyNames.refresh);
  const legacyCsrf = cookieValue(req, legacyNames.csrf);
  if (legacyAccess) {
    try {
      const payload = verifyAccessToken(legacyAccess);
      if (appKindFromRole(payload.role) === kind) {
        return { kind, access: legacyAccess, refresh: legacyRefresh, csrf: legacyCsrf, legacy: true };
      }
      return { kind, legacy: false };
    } catch {
      if (legacyRefresh) return { kind, refresh: legacyRefresh, csrf: legacyCsrf, legacy: true };
    }
  } else if (legacyRefresh) {
    return { kind, refresh: legacyRefresh, csrf: legacyCsrf, legacy: true };
  }
  return { kind, access, refresh, csrf, legacy: false };
}

export function setAuthCookies(res: Response, access: string, refresh: string, csrf: string, kind: AppKind) {
  const names = cookieNames[kind];
  res.cookie(names.access, access, { ...cookieBase, httpOnly: true, path: "/", maxAge: 15 * 60 * 1000 });
  res.cookie(names.refresh, refresh, {
    ...cookieBase,
    httpOnly: true,
    path: "/api/v1/auth",
    maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
  });
  res.cookie(names.csrf, csrf, {
    ...cookieBase,
    httpOnly: false,
    path: "/",
    maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response, kind: AppKind, includeLegacy = false) {
  const names = cookieNames[kind];
  res.clearCookie(names.access, { path: "/" });
  res.clearCookie(names.refresh, { path: "/api/v1/auth" });
  res.clearCookie(names.csrf, { path: "/" });
  if (includeLegacy) {
    res.clearCookie(legacyNames.access, { path: "/" });
    res.clearCookie(legacyNames.refresh, { path: "/api/v1/auth" });
    res.clearCookie(legacyNames.csrf, { path: "/" });
  }
}
