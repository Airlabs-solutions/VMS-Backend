import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { AppError } from "../lib/errors";
import { logger, redactMessage } from "../lib/logger";

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, "NOT_FOUND", "This endpoint does not exist"));
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: { code: "INVALID_FILE", message: "Upload a PDF, JPG or PNG up to 10 MB" } });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  const message = err instanceof Error ? err.message : "Unexpected error";
  logger.error({ path: req.path, message: redactMessage(message) }, "Unhandled error");
  const safe = redactMessage(message);
  res.status(500).json({
    error: {
      code: "INTERNAL",
      message: env.NODE_ENV === "production" ? "Something went wrong" : safe,
    },
  });
}
