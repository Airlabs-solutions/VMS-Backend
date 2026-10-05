import { Types } from "mongoose";
import { z } from "zod";
import { CLAIM_STATUSES, INSURANCE_TYPES } from "../../config/constants";
import { formatDisplayDate } from "../../lib/dates";
import { notFound } from "../../lib/errors";
import { formatSar, sarToHalalas } from "../../lib/money";
import { listArgs, listResult, writeXlsx } from "../../lib/pagination";
import { dateDto, moneyDto, statusDto } from "../../lib/present";
import { expiryStatus } from "../../lib/status";
import { Vehicle } from "../vehicles/model";
import { InsuranceClaim, InsurancePolicy } from "./model";

const idField = z.string().regex(/^[a-f\d]{24}$/i);

export const policyBody = z.object({
  vehicleId: idField,
  policyNumber: z.string().trim().min(1).max(60),
  insurer: z.string().trim().min(1).max(120),
  type: z.enum(INSURANCE_TYPES),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  premium: z.coerce.number().min(0),
  fileIds: z.array(idField).optional(),
});

export const claimBody = z.object({
  policyId: idField,
  vehicleId: idField,
  claimDate: z.coerce.date(),
  description: z.string().trim().min(1).max(2000),
  amount: z.coerce.number().min(0),
  status: z.enum(CLAIM_STATUSES).optional(),
  fileIds: z.array(idField).optional(),
});

function policyDto(row: {
  _id: unknown;
  vehicleId: unknown;
  policyNumber: string;
  insurer: string;
  type: string;
  startDate: Date;
  endDate: Date;
  premiumHalalas: number;
  fileIds?: unknown[];
}, plate = "") {
  return {
    id: String(row._id),
    vehicleId: String(row.vehicleId),
    plateNumber: plate,
    policyNumber: row.policyNumber,
    insurer: row.insurer,
    type: statusDto(row.type),
    startDate: dateDto(row.startDate),
    endDate: dateDto(row.endDate),
    premium: moneyDto(row.premiumHalalas),
    status: statusDto(expiryStatus(row.endDate)),
    fileIds: (row.fileIds ?? []).map(String),
  };
}

export async function listPolicies(raw: { page?: number; limit?: number; vehicleId?: string }) {
  const query = listArgs(raw, ["endDate", "insurer"], "endDate");
  const filter: Record<string, unknown> = {};
  if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
  const [rows, total] = await Promise.all([
    InsurancePolicy.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    InsurancePolicy.countDocuments(filter),
  ]);
  const vehicles = await Vehicle.find({ _id: { $in: rows.map((row) => row.vehicleId) } }).select("plateNumber").lean();
  const plates = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.plateNumber]));
  return listResult(rows.map((row) => policyDto(row, plates.get(String(row.vehicleId)) ?? "")), total, query);
}

export async function createPolicy(input: z.infer<typeof policyBody>) {
  const vehicle = await Vehicle.findById(input.vehicleId).lean();
  if (!vehicle) throw notFound("Vehicle");
  const row = await InsurancePolicy.create({
    vehicleId: vehicle._id,
    policyNumber: input.policyNumber,
    insurer: input.insurer,
    type: input.type,
    startDate: input.startDate,
    endDate: input.endDate,
    premiumHalalas: sarToHalalas(input.premium),
    fileIds: (input.fileIds ?? []).map((id) => new Types.ObjectId(id)),
  });
  return policyDto(row.toObject(), vehicle.plateNumber);
}

export async function listClaims(raw: { page?: number; limit?: number; vehicleId?: string }) {
  const query = listArgs(raw, ["claimDate"], "-claimDate");
  const filter: Record<string, unknown> = {};
  if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
  const [rows, total] = await Promise.all([
    InsuranceClaim.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    InsuranceClaim.countDocuments(filter),
  ]);
  return listResult(
    rows.map((row) => ({
      id: String(row._id),
      policyId: String(row.policyId),
      vehicleId: String(row.vehicleId),
      claimDate: dateDto(row.claimDate),
      description: row.description,
      amount: moneyDto(row.amountHalalas),
      status: statusDto(row.status),
      fileIds: (row.fileIds ?? []).map(String),
    })),
    total,
    query,
  );
}

export async function createClaim(input: z.infer<typeof claimBody>) {
  const policy = await InsurancePolicy.findById(input.policyId).lean();
  if (!policy) throw notFound("Policy");
  const row = await InsuranceClaim.create({
    policyId: policy._id,
    vehicleId: input.vehicleId,
    claimDate: input.claimDate,
    description: input.description,
    amountHalalas: sarToHalalas(input.amount),
    status: input.status ?? "submitted",
    fileIds: (input.fileIds ?? []).map((id) => new Types.ObjectId(id)),
  });
  return { id: String(row._id) };
}

export async function updateClaimStatus(id: string, status: (typeof CLAIM_STATUSES)[number]) {
  const row = await InsuranceClaim.findByIdAndUpdate(id, { status }, { new: true });
  if (!row) throw notFound("Claim");
  return { id: String(row._id), status: statusDto(row.status) };
}

export async function exportInsurance(res: import("express").Response) {
  const rows = await InsurancePolicy.find().sort({ endDate: 1 }).limit(10000).lean();
  const vehicles = await Vehicle.find({ _id: { $in: rows.map((row) => row.vehicleId) } }).select("plateNumber").lean();
  const plates = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.plateNumber]));
  await writeXlsx(
    res,
    "insurance.xlsx",
    [
      { header: "Plate", key: "plate" },
      { header: "Policy", key: "policyNumber" },
      { header: "Insurer", key: "insurer" },
      { header: "Type", key: "type" },
      { header: "Start", key: "startDate" },
      { header: "End", key: "endDate" },
      { header: "Premium", key: "premium" },
      { header: "Status", key: "status" },
    ],
    rows.map((row) => ({
      plate: plates.get(String(row.vehicleId)) ?? "",
      policyNumber: row.policyNumber,
      insurer: row.insurer,
      type: statusDto(row.type).label,
      startDate: formatDisplayDate(row.startDate),
      endDate: formatDisplayDate(row.endDate),
      premium: formatSar(row.premiumHalalas),
      status: statusDto(expiryStatus(row.endDate)).label,
    })),
  );
}
