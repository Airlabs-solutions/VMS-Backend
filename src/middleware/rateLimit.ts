import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env";

export function buildLimiter(max: number, windowMs = 15 * 60 * 1000) {
  if (env.RATE_LIMIT_DISABLED || !env.isProduction) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMIT", message: "Too many attempts. Try again later." } },
  });
}
