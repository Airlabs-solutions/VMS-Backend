import { AsyncLocalStorage } from "node:async_hooks";
import type { Role } from "../config/constants";

export type RequestContext = {
  userId?: string;
  role?: Role;
  companyId?: string | null;
  driverId?: string | null;
  supportGrantId?: string | null;
  skipTenant?: boolean;
  internal?: boolean;
  ip?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getCtx(): RequestContext {
  return requestContext.getStore() ?? {};
}

export function requireCompanyId(): string {
  const companyId = getCtx().companyId;
  if (!companyId) {
    throw new Error("Missing company context");
  }
  return companyId;
}
