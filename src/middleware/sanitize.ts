import type { NextFunction, Request, Response } from "express";

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("$") || key.includes(".")) continue;
    output[key] = strip(item);
  }
  return output;
}

/** Drops Mongo operator keys from JSON bodies. */
export function sanitize(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === "object") {
    req.body = strip(req.body);
  }
  next();
}
