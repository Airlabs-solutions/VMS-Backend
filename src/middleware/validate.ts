import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodTypeAny } from "zod";
import { AppError } from "../lib/errors";

export type Validated<T> = { body: T extends { body: infer B } ? B : undefined; query: T extends { query: infer Q } ? Q : undefined; params: T extends { params: infer P } ? P : undefined };

export function validate(schema: ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse({
      body: req.body ?? {},
      query: req.query ?? {},
      params: req.params ?? {},
    });
    if (!parsed.success) {
      const details = (parsed.error as ZodError).issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      return next(new AppError(400, "VALIDATION_ERROR", "Check the highlighted fields", details));
    }
    req.validated = parsed.data;
    next();
  };
}
