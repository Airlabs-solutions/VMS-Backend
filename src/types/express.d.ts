import type { Role } from "../config/constants";

export type AuthContext = {
  userId: string;
  role: Role;
  companyId: string | null;
  driverId: string | null;
  supportGrantId: string | null;
};

declare global {
  namespace Express {
    interface Request {
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
      ctx?: AuthContext;
    }
  }
}

export {};
