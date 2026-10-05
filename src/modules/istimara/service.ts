import { Types } from "mongoose";
import { z } from "zod";
import { formatDisplayDate } from "../../lib/dates";
import { notFound } from "../../lib/errors";
import { dateDto, statusDto } from "../../lib/present";
import { listArgs, listResult, writeXlsx } from "../../lib/pagination";
import { expiryStatus } from "../../lib/status";
import { Vehicle } from "../vehicles/model";
import { Istimara } from "./model";

export const istimaraBody = z.object({
  vehicleId: z.string().regex(/^[a-f\d]{24}$/i),
  number: z.string().trim().min(1).max(40),
  issueDate: z.coerce.date(),
  expiryDate: z.coerce.date(),
  fileIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).optional(),
});

function dto(row: {
  _id: unknown;
  vehicleId: unknown;
  number: string;
  issueDate: Date;
  expiryDate: Date;
  fileIds?: unknown[];
}, plate = "") {
  return {
    id: String(row._id),
    vehicleId: String(row.vehicleId),
    plateNumber: plate,
    number: row.number,
    issueDate: dateDto(row.issueDate),
    expiryDate: dateDto(row.expiryDate),
    status: statusDto(expiryStatus(row.expiryDate)),
    fileIds: (row.fileIds ?? []).map(String),
  };
}

export async function listIstimara(raw: { page?: number; limit?: number; vehicleId?: string }) {
  const query = listArgs(raw, ["expiryDate", "issueDate"], "expiryDate");
  const filter: Record<string, unknown> = {};
  if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
  const [rows, total] = await Promise.all([
    Istimara.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    Istimara.countDocuments(filter),
  ]);
  const vehicles = await Vehicle.find({ _id: { $in: rows.map((row) => row.vehicleId) } }).select("plateNumber").lean();
  const plates = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.plateNumber]));
  return listResult(rows.map((row) => dto(row, plates.get(String(row.vehicleId)) ?? "")), total, query);
}

export async function createIstimara(input: z.infer<typeof istimaraBody>) {
  const vehicle = await Vehicle.findById(input.vehicleId).lean();
  if (!vehicle) throw notFound("Vehicle");
  const row = await Istimara.create({
    vehicleId: vehicle._id,
    number: input.number,
    issueDate: input.issueDate,
    expiryDate: input.expiryDate,
    fileIds: (input.fileIds ?? []).map((id) => new Types.ObjectId(id)),
  });
  return dto(row.toObject(), vehicle.plateNumber);
}

export async function exportIstimara(res: import("express").Response) {
  const rows = await Istimara.find().sort({ expiryDate: 1 }).limit(10000).lean();
  const vehicles = await Vehicle.find({ _id: { $in: rows.map((row) => row.vehicleId) } }).select("plateNumber").lean();
  const plates = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.plateNumber]));
  await writeXlsx(
    res,
    "istimara.xlsx",
    [
      { header: "Plate", key: "plate" },
      { header: "Number", key: "number" },
      { header: "Issue date", key: "issueDate" },
      { header: "Expiry date", key: "expiryDate" },
      { header: "Status", key: "status" },
    ],
    rows.map((row) => ({
      plate: plates.get(String(row.vehicleId)) ?? "",
      number: row.number,
      issueDate: formatDisplayDate(row.issueDate),
      expiryDate: formatDisplayDate(row.expiryDate),
      status: statusDto(expiryStatus(row.expiryDate)).label,
    })),
  );
}
