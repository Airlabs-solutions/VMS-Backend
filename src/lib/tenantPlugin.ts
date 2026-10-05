import mongoose from "mongoose";
import { Schema, Types, type Query } from "mongoose";
import { getCtx } from "./context";
import { logger } from "./logger";

const QUERY_HOOKS = [
  "find",
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "countDocuments",
] as const;

function blockQuery(query: Query<unknown, unknown>) {
  query.where({ _id: { $exists: false } });
}

function applyTenant(query: Query<unknown, unknown>) {
  const options = query.getOptions() as { skipTenant?: boolean };
  const ctx = getCtx();
  if (options.skipTenant || ctx.skipTenant || ctx.internal) return;
  if (!ctx.companyId) {
    logger.error("Blocked a tenant query that had no company context");
    blockQuery(query);
    return;
  }
  query.where({ companyId: new Types.ObjectId(ctx.companyId) });
}

/**
 * Injects companyId into every query and rejects companyId changes.
 * companyId always comes from the request context, never from the client.
 */
export function tenantPlugin(schema: Schema) {
  schema.add({
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
  });

  for (const hook of QUERY_HOOKS) {
    schema.pre(hook, function tenantQuery(this: Query<unknown, unknown>) {
      applyTenant(this);
    });
  }

  schema.pre("aggregate", function tenantAggregate() {
    const ctx = getCtx();
    if (ctx.skipTenant || ctx.internal) return;
    const companyId = ctx.companyId
      ? new Types.ObjectId(ctx.companyId)
      : new Types.ObjectId("000000000000000000000000");
    if (!ctx.companyId) {
      logger.error("Blocked a tenant aggregate that had no company context");
    }
    this.pipeline().unshift({ $match: { companyId } });
  });

  schema.pre("validate", function tenantValidate() {
    const ctx = getCtx();
    if (ctx.skipTenant || ctx.internal) {
      if (!this.isNew && this.isModified("companyId")) {
        throw new Error("companyId cannot be changed");
      }
      return;
    }
    if (!ctx.companyId) {
      throw new Error("Missing company context");
    }
    if (!this.isNew && this.isModified("companyId")) {
      throw new Error("companyId cannot be changed");
    }
    if (this.isNew) {
      this.set("companyId", new Types.ObjectId(ctx.companyId));
    } else if (String(this.get("companyId")) !== ctx.companyId) {
      throw new Error("companyId mismatch");
    }
  });
}

export function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: number }).code === 11000);
}

export function asObjectId(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error("Invalid id");
  }
  return new Types.ObjectId(id);
}

let transactionsAvailable: boolean | null = null;

function transactionsUnsupported(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === "object" && "message" in current) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string" && message.includes("Transaction numbers are only allowed")) return true;
    }
    current = typeof current === "object" && current && "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

async function runWithoutTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await fn(session);
  } finally {
    await session.endSession();
  }
}

/**
 * Uses a MongoDB transaction when the server is a replica set.
 * A standalone server rejects transaction numbers, so the same work runs without one.
 */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  if (transactionsAvailable === false) return runWithoutTransaction(fn);

  const session = await mongoose.startSession();
  try {
    let result!: T;
    try {
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      transactionsAvailable = true;
      return result;
    } catch (error) {
      if (!transactionsUnsupported(error)) throw error;
      transactionsAvailable = false;
      logger.warn("MongoDB is not a replica set. Saving without a transaction.");
    }
  } finally {
    await session.endSession();
  }
  return runWithoutTransaction(fn);
}
