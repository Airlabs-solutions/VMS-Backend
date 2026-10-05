import { Types } from "mongoose";
import { z } from "zod";
import { EXPENSE_CATEGORIES, FUEL_APPROVAL, VIOLATION_STATUSES } from "../../config/constants";
import { formatDisplayDate } from "../../lib/dates";
import { AppError, notFound } from "../../lib/errors";
import { formatSar, sarToHalalas } from "../../lib/money";
import { listArgs, listResult, writeXlsx } from "../../lib/pagination";
import { dateDto, moneyDto, sid, statusDto } from "../../lib/present";
import { raiseViolationAlert } from "../alerts/service";
import { driverForVehicleOnDate } from "../drivers/service";
import { bumpOdometer } from "../vehicles/service";
import { Vehicle } from "../vehicles/model";
import { Expense, FuelLog, Trip, Violation } from "./model";

const idField = z.string().regex(/^[a-f\d]{24}$/i);

export const fuelBody = z.object({
  vehicleId: idField,
  driverId: idField.optional(),
  date: z.coerce.date(),
  liters: z.coerce.number().positive(),
  cost: z.coerce.number().min(0),
  odometerKm: z.coerce.number().int().min(0),
  station: z.string().trim().max(120).optional().or(z.literal("")),
  fileIds: z.array(idField).optional(),
  approvalStatus: z.enum(FUEL_APPROVAL).optional(),
});

export const violationBody = z.object({
  vehicleId: idField,
  driverId: idField.optional(),
  number: z.string().trim().min(1).max(40),
  date: z.coerce.date(),
  type: z.string().trim().min(1).max(80),
  amount: z.coerce.number().min(0),
  status: z.enum(VIOLATION_STATUSES).optional(),
  deductFromDriver: z.boolean().optional(),
});

export const tripBody = z.object({
  vehicleId: idField,
  driverId: idField.optional(),
  date: z.coerce.date(),
  startLocation: z.string().trim().min(1).max(160),
  endLocation: z.string().trim().min(1).max(160),
  startKm: z.coerce.number().int().min(0),
  endKm: z.coerce.number().int().min(0),
  purpose: z.string().trim().max(200).optional().or(z.literal("")),
});

export const expenseBody = z.object({
  vehicleId: idField,
  category: z.enum(EXPENSE_CATEGORIES),
  amount: z.coerce.number().min(0),
  date: z.coerce.date(),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  fileIds: z.array(idField).optional(),
});

async function platesFor(ids: unknown[]) {
  const vehicles = await Vehicle.find({ _id: { $in: ids } }).select("plateNumber").lean();
  return new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.plateNumber]));
}

export async function listFuel(raw: { page?: number; limit?: number; vehicleId?: string; driverId?: string }) {
  const query = listArgs(raw, ["date", "costHalalas"], "-date");
  const filter: Record<string, unknown> = {};
  if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
  if (raw.driverId) filter.driverId = raw.driverId;
  const [rows, total] = await Promise.all([
    FuelLog.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    FuelLog.countDocuments(filter),
  ]);
  const plates = await platesFor(rows.map((row) => row.vehicleId));
  return listResult(
    rows.map((row) => ({
      id: String(row._id),
      vehicleId: String(row.vehicleId),
      plateNumber: plates.get(String(row.vehicleId)) ?? "",
      driverId: sid(row.driverId),
      date: dateDto(row.date),
      liters: row.liters,
      cost: moneyDto(row.costHalalas),
      odometerKm: row.odometerKm,
      station: row.station ?? "",
      approvalStatus: statusDto(row.approvalStatus),
      fileIds: (row.fileIds ?? []).map(String),
    })),
    total,
    query,
  );
}

export async function createFuel(input: z.infer<typeof fuelBody>, approvalStatus: "pending" | "approved" = "approved") {
  const vehicle = await Vehicle.findById(input.vehicleId);
  if (!vehicle) throw notFound("Vehicle");
  const row = await FuelLog.create({
    vehicleId: vehicle._id,
    driverId: input.driverId ? new Types.ObjectId(input.driverId) : undefined,
    date: input.date,
    liters: input.liters,
    costHalalas: sarToHalalas(input.cost),
    odometerKm: input.odometerKm,
    station: input.station,
    fileIds: (input.fileIds ?? []).map((id) => new Types.ObjectId(id)),
    approvalStatus: input.approvalStatus ?? approvalStatus,
  });
  if (row.approvalStatus === "approved") await bumpOdometer(String(vehicle._id), input.odometerKm);
  return { id: String(row._id) };
}

export async function setFuelApproval(id: string, approvalStatus: "approved" | "rejected") {
  const row = await FuelLog.findById(id);
  if (!row) throw notFound("Fuel log");
  row.approvalStatus = approvalStatus;
  await row.save();
  if (approvalStatus === "approved") await bumpOdometer(String(row.vehicleId), row.odometerKm);
  return { id: String(row._id), approvalStatus: statusDto(row.approvalStatus) };
}

export async function listViolations(raw: { page?: number; limit?: number; vehicleId?: string; driverId?: string; status?: string }) {
  const query = listArgs(raw, ["date", "amountHalalas"], "-date");
  const filter: Record<string, unknown> = {};
  if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
  if (raw.driverId) filter.driverId = raw.driverId;
  if (raw.status) filter.status = raw.status;
  const [rows, total] = await Promise.all([
    Violation.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    Violation.countDocuments(filter),
  ]);
  const plates = await platesFor(rows.map((row) => row.vehicleId));
  return listResult(
    rows.map((row) => ({
      id: String(row._id),
      vehicleId: String(row.vehicleId),
      plateNumber: plates.get(String(row.vehicleId)) ?? "",
      driverId: sid(row.driverId),
      number: row.number,
      date: dateDto(row.date),
      type: row.type,
      amount: moneyDto(row.amountHalalas),
      status: statusDto(row.status),
      deductFromDriver: row.deductFromDriver,
    })),
    total,
    query,
  );
}

export async function createViolation(input: z.infer<typeof violationBody>) {
  const vehicle = await Vehicle.findById(input.vehicleId).lean();
  if (!vehicle) throw notFound("Vehicle");
  const driverId = input.driverId ?? (await driverForVehicleOnDate(input.vehicleId, input.date));
  try {
    const row = await Violation.create({
      vehicleId: vehicle._id,
      driverId: driverId ? new Types.ObjectId(driverId) : undefined,
      number: input.number,
      date: input.date,
      type: input.type,
      amountHalalas: sarToHalalas(input.amount),
      status: input.status ?? "unpaid",
      deductFromDriver: input.deductFromDriver ?? false,
    });
    await raiseViolationAlert({
      violationId: String(row._id),
      vehicleId: String(vehicle._id),
      plateNumber: vehicle.plateNumber,
      driverId: driverId ?? undefined,
      amountHalalas: row.amountHalalas,
    });
    return { id: String(row._id), driverId };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code: number }).code === 11000) {
      throw new AppError(409, "DUPLICATE", "This violation number already exists");
    }
    throw error;
  }
}

export async function updateViolation(id: string, input: { status?: "unpaid" | "paid" | "disputed"; deductFromDriver?: boolean }) {
  const row = await Violation.findById(id);
  if (!row) throw notFound("Violation");
  if (input.status) row.status = input.status;
  if (input.deductFromDriver != null) row.deductFromDriver = input.deductFromDriver;
  await row.save();
  return { id: String(row._id), status: statusDto(row.status), deductFromDriver: row.deductFromDriver };
}

export async function listTrips(raw: { page?: number; limit?: number; vehicleId?: string; driverId?: string }) {
  const query = listArgs(raw, ["date", "distanceKm"], "-date");
  const filter: Record<string, unknown> = {};
  if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
  if (raw.driverId) filter.driverId = raw.driverId;
  const [rows, total] = await Promise.all([
    Trip.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    Trip.countDocuments(filter),
  ]);
  const plates = await platesFor(rows.map((row) => row.vehicleId));
  return listResult(
    rows.map((row) => ({
      id: String(row._id),
      vehicleId: String(row.vehicleId),
      plateNumber: plates.get(String(row.vehicleId)) ?? "",
      driverId: sid(row.driverId),
      date: dateDto(row.date),
      startLocation: row.startLocation,
      endLocation: row.endLocation,
      startKm: row.startKm,
      endKm: row.endKm,
      distanceKm: row.distanceKm,
      purpose: row.purpose ?? "",
    })),
    total,
    query,
  );
}

export async function createTrip(input: z.infer<typeof tripBody>) {
  const vehicle = await Vehicle.findById(input.vehicleId);
  if (!vehicle) throw notFound("Vehicle");
  if (input.endKm < input.startKm) {
    throw new AppError(400, "VALIDATION_ERROR", "End odometer must be greater than or equal to the start");
  }
  const distanceKm = input.endKm - input.startKm;
  const row = await Trip.create({
    vehicleId: vehicle._id,
    driverId: input.driverId ? new Types.ObjectId(input.driverId) : undefined,
    date: input.date,
    startLocation: input.startLocation,
    endLocation: input.endLocation,
    startKm: input.startKm,
    endKm: input.endKm,
    distanceKm,
    purpose: input.purpose,
  });
  await bumpOdometer(String(vehicle._id), input.endKm);
  return { id: String(row._id), distanceKm };
}

export async function listExpenses(raw: { page?: number; limit?: number; vehicleId?: string; category?: string }) {
  const query = listArgs(raw, ["date", "amountHalalas"], "-date");
  const filter: Record<string, unknown> = {};
  if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
  if (raw.category) filter.category = raw.category;
  const [rows, total] = await Promise.all([
    Expense.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    Expense.countDocuments(filter),
  ]);
  const plates = await platesFor(rows.map((row) => row.vehicleId));
  return listResult(
    rows.map((row) => ({
      id: String(row._id),
      vehicleId: String(row.vehicleId),
      plateNumber: plates.get(String(row.vehicleId)) ?? "",
      category: statusDto(row.category),
      amount: moneyDto(row.amountHalalas),
      date: dateDto(row.date),
      notes: row.notes ?? "",
      fileIds: (row.fileIds ?? []).map(String),
    })),
    total,
    query,
  );
}

export async function createExpense(input: z.infer<typeof expenseBody>) {
  const vehicle = await Vehicle.findById(input.vehicleId).lean();
  if (!vehicle) throw notFound("Vehicle");
  const row = await Expense.create({
    vehicleId: vehicle._id,
    category: input.category,
    amountHalalas: sarToHalalas(input.amount),
    date: input.date,
    notes: input.notes,
    fileIds: (input.fileIds ?? []).map((id) => new Types.ObjectId(id)),
  });
  return { id: String(row._id) };
}

export async function exportRows(
  res: import("express").Response,
  kind: "fuel" | "violations" | "trips" | "expenses",
) {
  if (kind === "fuel") {
    const rows = await FuelLog.find().sort({ date: -1 }).limit(10000).lean();
    const plates = await platesFor(rows.map((row) => row.vehicleId));
    await writeXlsx(res, "fuel.xlsx", [
      { header: "Date", key: "date" },
      { header: "Plate", key: "plate" },
      { header: "Liters", key: "liters" },
      { header: "Cost", key: "cost" },
      { header: "Odometer (km)", key: "odometerKm" },
      { header: "Station", key: "station" },
      { header: "Approval", key: "approval" },
    ], rows.map((row) => ({
      date: formatDisplayDate(row.date),
      plate: plates.get(String(row.vehicleId)) ?? "",
      liters: row.liters,
      cost: formatSar(row.costHalalas),
      odometerKm: row.odometerKm,
      station: row.station ?? "",
      approval: statusDto(row.approvalStatus).label,
    })));
    return;
  }
  if (kind === "violations") {
    const rows = await Violation.find().sort({ date: -1 }).limit(10000).lean();
    const plates = await platesFor(rows.map((row) => row.vehicleId));
    await writeXlsx(res, "violations.xlsx", [
      { header: "Date", key: "date" },
      { header: "Plate", key: "plate" },
      { header: "Number", key: "number" },
      { header: "Type", key: "type" },
      { header: "Amount", key: "amount" },
      { header: "Status", key: "status" },
      { header: "Deduct from driver", key: "deduct" },
    ], rows.map((row) => ({
      date: formatDisplayDate(row.date),
      plate: plates.get(String(row.vehicleId)) ?? "",
      number: row.number,
      type: row.type,
      amount: formatSar(row.amountHalalas),
      status: statusDto(row.status).label,
      deduct: row.deductFromDriver ? "Yes" : "No",
    })));
    return;
  }
  if (kind === "trips") {
    const rows = await Trip.find().sort({ date: -1 }).limit(10000).lean();
    const plates = await platesFor(rows.map((row) => row.vehicleId));
    await writeXlsx(res, "trips.xlsx", [
      { header: "Date", key: "date" },
      { header: "Plate", key: "plate" },
      { header: "From", key: "startLocation" },
      { header: "To", key: "endLocation" },
      { header: "Start km", key: "startKm" },
      { header: "End km", key: "endKm" },
      { header: "Distance (km)", key: "distanceKm" },
      { header: "Purpose", key: "purpose" },
    ], rows.map((row) => ({
      date: formatDisplayDate(row.date),
      plate: plates.get(String(row.vehicleId)) ?? "",
      startLocation: row.startLocation,
      endLocation: row.endLocation,
      startKm: row.startKm,
      endKm: row.endKm,
      distanceKm: row.distanceKm,
      purpose: row.purpose ?? "",
    })));
    return;
  }
  const rows = await Expense.find().sort({ date: -1 }).limit(10000).lean();
  const plates = await platesFor(rows.map((row) => row.vehicleId));
  await writeXlsx(res, "expenses.xlsx", [
    { header: "Date", key: "date" },
    { header: "Plate", key: "plate" },
    { header: "Category", key: "category" },
    { header: "Amount", key: "amount" },
    { header: "Notes", key: "notes" },
  ], rows.map((row) => ({
    date: formatDisplayDate(row.date),
    plate: plates.get(String(row.vehicleId)) ?? "",
    category: statusDto(row.category).label,
    amount: formatSar(row.amountHalalas),
    notes: row.notes ?? "",
  })));
}
