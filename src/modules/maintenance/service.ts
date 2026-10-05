import { Types } from "mongoose";
import { z } from "zod";
import { addMonths, formatDisplayDate } from "../../lib/dates";
import { AppError, notFound } from "../../lib/errors";
import { dateDto, moneyDto, statusDto } from "../../lib/present";
import { sarToHalalas } from "../../lib/money";
import { listArgs, listResult, writeXlsx } from "../../lib/pagination";
import { maintenanceStatus } from "../../lib/status";
import { bumpOdometer } from "../vehicles/service";
import { Vehicle } from "../vehicles/model";
import { MaintenanceLog, MaintenanceSchedule } from "./model";

export const scheduleBody = z.object({
  vehicleId: z.string().regex(/^[a-f\d]{24}$/i),
  serviceType: z.string().trim().min(1).max(80),
  intervalMonths: z.coerce.number().int().min(1).max(60),
  intervalKm: z.coerce.number().int().min(1),
  lastServiceDate: z.coerce.date().optional(),
  lastServiceKm: z.coerce.number().int().min(0).optional(),
});

export const logBody = z.object({
  vehicleId: z.string().regex(/^[a-f\d]{24}$/i),
  scheduleId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  date: z.coerce.date(),
  odometerKm: z.coerce.number().int().min(0),
  serviceType: z.string().trim().min(1).max(80),
  workshop: z.string().trim().max(120).optional().or(z.literal("")),
  cost: z.coerce.number().min(0),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  fileIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).optional(),
});

async function scheduleDto(schedule: {
  _id: unknown;
  vehicleId: unknown;
  serviceType: string;
  intervalMonths: number;
  intervalKm: number;
  lastServiceDate?: Date | null;
  lastServiceKm?: number | null;
  nextDueDate: Date;
  nextDueKm: number;
}) {
  const vehicle = await Vehicle.findById(schedule.vehicleId).select("odometerKm plateNumber").lean();
  const status = maintenanceStatus({
    nextDueDate: schedule.nextDueDate,
    nextDueKm: schedule.nextDueKm,
    odometerKm: vehicle?.odometerKm ?? 0,
  });
  return {
    id: String(schedule._id),
    vehicleId: String(schedule.vehicleId),
    plateNumber: vehicle?.plateNumber ?? "",
    serviceType: schedule.serviceType,
    intervalMonths: schedule.intervalMonths,
    intervalKm: schedule.intervalKm,
    lastServiceDate: dateDto(schedule.lastServiceDate),
    lastServiceKm: schedule.lastServiceKm ?? null,
    nextDueDate: dateDto(schedule.nextDueDate),
    nextDueKm: schedule.nextDueKm,
    status: statusDto(status),
  };
}

export async function listSchedules(raw: { page?: number; limit?: number; vehicleId?: string; q?: string }) {
  const query = listArgs(raw, ["nextDueDate", "serviceType"], "nextDueDate");
  const filter: Record<string, unknown> = {};
  if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
  const [rows, total] = await Promise.all([
    MaintenanceSchedule.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    MaintenanceSchedule.countDocuments(filter),
  ]);
  return listResult(await Promise.all(rows.map((row) => scheduleDto(row))), total, query);
}

export async function createSchedule(input: z.infer<typeof scheduleBody>) {
  const vehicle = await Vehicle.findById(input.vehicleId);
  if (!vehicle) throw notFound("Vehicle");
  const baseDate = input.lastServiceDate ?? new Date();
  const baseKm = input.lastServiceKm ?? vehicle.odometerKm;
  const schedule = await MaintenanceSchedule.create({
    vehicleId: vehicle._id,
    serviceType: input.serviceType,
    intervalMonths: input.intervalMonths,
    intervalKm: input.intervalKm,
    lastServiceDate: input.lastServiceDate,
    lastServiceKm: input.lastServiceKm,
    nextDueDate: addMonths(baseDate, input.intervalMonths),
    nextDueKm: baseKm + input.intervalKm,
  });
  return scheduleDto(schedule.toObject());
}

export async function listLogs(raw: { page?: number; limit?: number; vehicleId?: string }) {
  const query = listArgs(raw, ["date", "costHalalas"], "-date");
  const filter: Record<string, unknown> = {};
  if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
  const [rows, total] = await Promise.all([
    MaintenanceLog.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    MaintenanceLog.countDocuments(filter),
  ]);
  return listResult(
    rows.map((row) => ({
      id: String(row._id),
      vehicleId: String(row.vehicleId),
      scheduleId: row.scheduleId ? String(row.scheduleId) : null,
      date: dateDto(row.date),
      odometerKm: row.odometerKm,
      serviceType: row.serviceType,
      workshop: row.workshop ?? "",
      cost: moneyDto(row.costHalalas),
      notes: row.notes ?? "",
      fileIds: (row.fileIds ?? []).map(String),
    })),
    total,
    query,
  );
}

export async function createLog(input: z.infer<typeof logBody>) {
  const vehicle = await Vehicle.findById(input.vehicleId);
  if (!vehicle) throw notFound("Vehicle");
  const log = await MaintenanceLog.create({
    vehicleId: vehicle._id,
    scheduleId: input.scheduleId ? new Types.ObjectId(input.scheduleId) : undefined,
    date: input.date,
    odometerKm: input.odometerKm,
    serviceType: input.serviceType,
    workshop: input.workshop,
    costHalalas: sarToHalalas(input.cost),
    notes: input.notes,
    fileIds: (input.fileIds ?? []).map((id) => new Types.ObjectId(id)),
  });
  await bumpOdometer(String(vehicle._id), input.odometerKm);
  if (input.scheduleId) {
    const schedule = await MaintenanceSchedule.findById(input.scheduleId);
    if (!schedule) throw new AppError(404, "NOT_FOUND", "Maintenance schedule was not found");
    schedule.lastServiceDate = input.date;
    schedule.lastServiceKm = input.odometerKm;
    schedule.nextDueDate = addMonths(input.date, schedule.intervalMonths);
    schedule.nextDueKm = input.odometerKm + schedule.intervalKm;
    await schedule.save();
  }
  return { id: String(log._id) };
}

export async function exportMaintenance(res: import("express").Response) {
  const rows = await MaintenanceLog.find().sort({ date: -1 }).limit(10000).lean();
  const vehicles = await Vehicle.find({ _id: { $in: rows.map((row) => row.vehicleId) } }).select("plateNumber").lean();
  const plates = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.plateNumber]));
  await writeXlsx(
    res,
    "maintenance.xlsx",
    [
      { header: "Date", key: "date", width: 14 },
      { header: "Plate", key: "plate" },
      { header: "Service", key: "serviceType" },
      { header: "Workshop", key: "workshop" },
      { header: "Odometer (km)", key: "odometerKm" },
      { header: "Cost", key: "cost" },
      { header: "Notes", key: "notes", width: 30 },
    ],
    rows.map((row) => ({
      date: formatDisplayDate(row.date),
      plate: plates.get(String(row.vehicleId)) ?? "",
      serviceType: row.serviceType,
      workshop: row.workshop ?? "",
      odometerKm: row.odometerKm,
      cost: (row.costHalalas / 100).toFixed(2),
      notes: row.notes ?? "",
    })),
  );
}
