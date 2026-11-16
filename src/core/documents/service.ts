import { Types } from "mongoose";
import { z } from "zod";
import { AppError, notFound } from "../../lib/errors";
import { dateDto, statusDto } from "../../lib/present";
import { expiryStatus } from "../../lib/status";
import { ComplianceDocument } from "./model";
import { getDocumentTypeDefinition } from "./registry";

export const complianceDocBody = z.object({
  ownerRef: z.object({
    kind: z.enum(["vehicle", "equipment", "employee"]),
    id: z.string().regex(/^[a-f\d]{24}$/i),
  }),
  docType: z.string().min(1).max(60),
  number: z.string().trim().min(1).max(60),
  issueDate: z.coerce.date().optional(),
  expiryDate: z.coerce.date(),
  fileIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ComplianceDocInput = z.infer<typeof complianceDocBody>;

export async function listComplianceDocuments(ownerKind?: string, ownerId?: string, docType?: string) {
  const filter: Record<string, unknown> = {};
  if (ownerKind) filter["ownerRef.kind"] = ownerKind;
  if (ownerId) filter["ownerRef.id"] = new Types.ObjectId(ownerId);
  if (docType) filter["docType"] = docType;

  const docs = await ComplianceDocument.find(filter).sort({ expiryDate: 1 }).lean();
  return docs.map((doc) => ({
    id: String(doc._id),
    ownerRef: {
      kind: doc.ownerRef?.kind ?? "vehicle",
      id: doc.ownerRef?.id ? String(doc.ownerRef.id) : "",
    },
    module: doc.module,
    docType: doc.docType,
    number: doc.number,
    issueDate: dateDto(doc.issueDate),
    expiryDate: dateDto(doc.expiryDate),
    isCurrent: doc.isCurrent,
    status: statusDto(expiryStatus(doc.expiryDate)),
    fileIds: (doc.fileIds ?? []).map(String),
    metadata: doc.metadata ? Object.fromEntries(doc.metadata as any) : {},
  }));
}

export async function createComplianceDocument(input: ComplianceDocInput) {
  const definition = getDocumentTypeDefinition(input.docType);
  const moduleName = definition ? definition.module : "fleet";

  // Mark previous current document of same type and owner as not current
  await ComplianceDocument.updateMany(
    {
      "ownerRef.kind": input.ownerRef.kind,
      "ownerRef.id": new Types.ObjectId(input.ownerRef.id),
      docType: input.docType,
      isCurrent: true,
    },
    { $set: { isCurrent: false } },
  );

  const doc = await ComplianceDocument.create({
    ownerRef: {
      kind: input.ownerRef.kind,
      id: new Types.ObjectId(input.ownerRef.id),
    },
    module: moduleName,
    docType: input.docType,
    number: input.number,
    issueDate: input.issueDate,
    expiryDate: input.expiryDate,
    fileIds: (input.fileIds ?? []).map((id) => new Types.ObjectId(id)),
    isCurrent: true,
    metadata: input.metadata ?? {},
  });

  return {
    id: String(doc._id),
    ownerRef: input.ownerRef,
    module: doc.module,
    docType: doc.docType,
    number: doc.number,
    issueDate: dateDto(doc.issueDate),
    expiryDate: dateDto(doc.expiryDate),
    isCurrent: doc.isCurrent,
    status: statusDto(expiryStatus(doc.expiryDate)),
  };
}

export async function getComplianceDocument(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "VALIDATION_ERROR", "Invalid document ID");
  const doc = await ComplianceDocument.findById(id).lean();
  if (!doc) throw notFound("ComplianceDocument");

  return {
    id: String(doc._id),
    ownerRef: {
      kind: doc.ownerRef?.kind ?? "vehicle",
      id: doc.ownerRef?.id ? String(doc.ownerRef.id) : "",
    },
    module: doc.module,
    docType: doc.docType,
    number: doc.number,
    issueDate: dateDto(doc.issueDate),
    expiryDate: dateDto(doc.expiryDate),
    isCurrent: doc.isCurrent,
    status: statusDto(expiryStatus(doc.expiryDate)),
    fileIds: (doc.fileIds ?? []).map(String),
    metadata: doc.metadata ? Object.fromEntries(doc.metadata as any) : {},
  };
}
