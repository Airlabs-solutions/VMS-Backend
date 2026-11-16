import { z } from "zod";

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
export const objectIdString = objectId;

export const money = z.coerce.number().min(0).max(100_000_000);
export const moneyInput = money;
export const km = z.coerce.number().int().min(0).max(10_000_000);
export const shortText = z.string().trim().min(1).max(120);
export const notes = z.string().trim().max(2000).optional().or(z.literal(""));
export const dateInput = z.coerce.date();
export const dateString = z.union([z.string().trim().min(1), z.date()]);
export const saudiIqama = z.string().trim().regex(/^[12]\d{9}$/, "Iqama or National ID must be 10 digits starting with 1 or 2");
export const saudiMobile = z.string().trim().min(8).max(20);

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  filter: z.record(z.string(), z.string().max(80)).optional(),
});

export function bodySchema<T extends z.ZodTypeAny>(body: T) {
  return z.object({
    body,
    query: z.object({}).passthrough().optional(),
    params: z.object({}).passthrough().optional(),
  });
}

export function querySchema<T extends z.ZodRawShape>(query: T) {
  return z.object({
    body: z.object({}).optional(),
    query: z.object(query),
    params: z.object({}).optional(),
  });
}

export function paramsSchema<T extends z.ZodRawShape>(params: T) {
  return z.object({
    body: z.object({}).optional(),
    query: z.object({}).passthrough().optional(),
    params: z.object(params),
  });
}
