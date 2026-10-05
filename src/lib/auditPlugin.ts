import { Schema, Types } from "mongoose";
import { AuditLog } from "../modules/audit/model";
import { getCtx } from "./context";

const SENSITIVE = new Set([
  "passwordHash",
  "mobileEnc",
  "iqamaEnc",
  "licenseNumberEnc",
  "mobile",
  "iqamaNumber",
  "licenseNumber",
  "codeHash",
  "tokenHash",
]);

function clean(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(clean);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE.has(key)) continue;
    if (key === "_id" || key.endsWith("Id")) {
      output[key] = item == null ? null : String(item);
      continue;
    }
    output[key] = clean(item);
  }
  return output;
}

async function writeAudit(action: "create" | "update" | "delete", collectionName: string, docId: unknown, before: unknown, after: unknown) {
  const ctx = getCtx();
  await AuditLog.create({
    companyId: ctx.companyId ? new Types.ObjectId(ctx.companyId) : undefined,
    actorId: ctx.userId ? new Types.ObjectId(ctx.userId) : undefined,
    action,
    collectionName,
    docId: docId ? String(docId) : undefined,
    before: before ? clean(before) : undefined,
    after: after ? clean(after) : undefined,
    at: new Date(),
    ip: ctx.ip,
    supportGrantId: ctx.supportGrantId,
  });
}

/** Records create, update and delete without storing personal identifiers. */
export function auditPlugin(schema: Schema) {
  schema.add({
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  });

  schema.pre("save", function stampUser() {
    const ctx = getCtx();
    if (!ctx.userId) return;
    if (this.isNew) this.set("createdBy", new Types.ObjectId(ctx.userId));
    this.set("updatedBy", new Types.ObjectId(ctx.userId));
  });

  schema.pre("save", async function captureBefore() {
    if (this.isNew) return;
    const model = this.constructor as unknown as { findById: (id: unknown) => { lean: () => Promise<unknown> } };
    const before = await model.findById(this._id).lean();
    this.$locals.before = before;
  });

  schema.post("save", async function auditSave() {
    const action = this.$locals.before ? "update" : "create";
    const plain = this.toObject();
    await writeAudit(action, this.collection.name, this._id, this.$locals.before, plain);
  });

  schema.pre("findOneAndUpdate", async function captureUpdate() {
    const before = await this.model.findOne(this.getFilter()).lean();
    this.setOptions({ new: true });
    (this as unknown as { _auditBefore?: unknown })._auditBefore = before;
  });

  schema.post("findOneAndUpdate", async function auditUpdate(doc) {
    const before = (this as unknown as { _auditBefore?: unknown })._auditBefore;
    if (!doc) return;
    await writeAudit("update", this.model.collection.name, (doc as { _id?: unknown })._id, before, doc);
  });

  schema.pre("findOneAndDelete", async function captureDelete() {
    const before = await this.model.findOne(this.getFilter()).lean();
    (this as unknown as { _auditBefore?: unknown })._auditBefore = before;
  });

  schema.post("findOneAndDelete", async function auditDelete() {
    const before = (this as unknown as { _auditBefore?: unknown })._auditBefore;
    if (!before) return;
    await writeAudit("delete", this.model.collection.name, (before as { _id?: unknown })._id, before, undefined);
  });
}
