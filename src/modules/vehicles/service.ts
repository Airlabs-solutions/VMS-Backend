import { Types, type ClientSession } from "mongoose";
import { z } from "zod";
import { FUEL_TYPES, OWNERSHIP_TYPES, VEHICLE_STATUSES, VEHICLE_TYPES } from "../../config/constants";
import { AppError, notFound } from "../../lib/errors";
import { escapeRegex, listArgs, listResult, readSheetRows, workbookBuffer, writeXlsx, type ListQuery } from "../../lib/pagination";
import { dateDto, sid, statusDto } from "../../lib/present";
import { isDuplicateKey, withTransaction } from "../../lib/tenantPlugin";
import { requireCompanyId } from "../../lib/context";
import { Company } from "../companies/model";
import { Assignment, Driver } from "../drivers/model";
import { InsurancePolicy } from "../insurance/model";
import { Istimara } from "../istimara/model";
import { MaintenanceSchedule } from "../maintenance/model";
import { expiryStatus, maintenanceStatus } from "../../lib/status";
import { ImportBatch, Vehicle } from "./model";

const SORT = ["plateNumber", "make", "year", "status", "createdAt", "odometerKm"];

export const vehicleBody = z.object({
  name: z.string().trim().max(80).optional(),
  plateNumber: z.string().trim().min(2).max(20),
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  year: z.coerce.number().int().min(1980).max(2100),
  color: z.string().trim().min(1).max(40),
  fuelType: z.enum(FUEL_TYPES).optional(),
  platePhotoId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  vehiclePhotoId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  photoIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(12).optional(),
  note: z.string().trim().max(2000).optional(),
  insuranceStart: z.string().trim().optional(),
  insuranceEnd: z.string().trim().optional(),
  vin: z.string().trim().min(3).max(32),
  type: z.enum(VEHICLE_TYPES),
  ownership: z.enum(OWNERSHIP_TYPES),
  odometerKm: z.coerce.number().int().min(0),
  pucExpiry: z.string().trim().optional(),
  fitnessExpiry: z.string().trim().optional(),
  status: z.enum(VEHICLE_STATUSES).optional(),
});

type VehicleInput = z.infer<typeof vehicleBody>;

function vehicleDto(vehicle: {
  _id: unknown;
  name?: string;
  plateNumber: string;
  make: string;
  modelName: string;
  year: number;
  color: string;
  fuelType?: string;
  platePhotoId?: unknown;
  vehiclePhotoId?: unknown;
  photoIds?: unknown[];
  note?: string;
  vin: string;
  type: string;
  ownership: string;
  odometerKm: number;
  pucExpiry?: Date | null;
  fitnessExpiry?: Date | null;
  status: string;
  currentDriverId?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: String(vehicle._id),
    name: vehicle.name || `${vehicle.make} ${vehicle.modelName}`,
    plateNumber: vehicle.plateNumber,
    make: vehicle.make,
    model: vehicle.modelName,
    year: vehicle.year,
    color: vehicle.color,
    fuelType: statusDto(vehicle.fuelType || "petrol"),
    platePhotoId: sid(vehicle.platePhotoId),
    vehiclePhotoId: sid(vehicle.vehiclePhotoId),
    photoIds: (vehicle.photoIds ?? []).map((id) => String(id)),
    note: vehicle.note ?? "",
    vin: vehicle.vin,
    type: statusDto(vehicle.type),
    ownership: statusDto(vehicle.ownership),
    odometerKm: vehicle.odometerKm,
    pucExpiry: dateDto(vehicle.pucExpiry),
    fitnessExpiry: dateDto(vehicle.fitnessExpiry),
    status: statusDto(vehicle.status),
    currentDriverId: sid(vehicle.currentDriverId),
    createdAt: dateDto(vehicle.createdAt),
    updatedAt: dateDto(vehicle.updatedAt),
  };
}

async function assertCapacity(extra: number) {
  const company = await Company.findById(requireCompanyId()).lean();
  if (!company) throw notFound("Company");
  const count = await Vehicle.countDocuments();
  if (count + extra > company.maxVehicles) {
    throw new AppError(409, "VEHICLE_LIMIT", `This company can store ${company.maxVehicles} vehicles`);
  }
}

function filterOf(query: ListQuery) {
  const filter: Record<string, unknown> = {};
  if (query.filter.status) filter.status = query.filter.status;
  if (query.filter.ownership) filter.ownership = query.filter.ownership;
  if (query.filter.type) filter.type = query.filter.type;
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [{ plateNumber: pattern }, { name: pattern }, { make: pattern }, { modelName: pattern }];
  }
  return filter;
}

function insuranceDto(policy: { startDate: Date; endDate: Date } | null | undefined) {
  if (!policy) return null;
  return {
    startDate: dateDto(policy.startDate),
    endDate: dateDto(policy.endDate),
    status: statusDto(expiryStatus(policy.endDate)),
  };
}

export async function listVehicles(raw: Parameters<typeof listArgs>[0]) {
  const query = listArgs(raw, SORT, "plateNumber");
  const filter = filterOf(query);
  const [rows, total] = await Promise.all([
    Vehicle.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    Vehicle.countDocuments(filter),
  ]);
  const driverIds = rows.map((row) => row.currentDriverId).filter(Boolean);
  const [drivers, policies] = await Promise.all([
    Driver.find({ _id: { $in: driverIds } }).select("name").lean(),
    InsurancePolicy.find({ vehicleId: { $in: rows.map((row) => row._id) } }).sort({ endDate: -1 }).lean(),
  ]);
  const names = new Map(drivers.map((driver) => [String(driver._id), driver.name]));
  const insuranceByVehicle = new Map<string, (typeof policies)[number]>();
  for (const policy of policies) {
    const key = String(policy.vehicleId);
    if (!insuranceByVehicle.has(key)) insuranceByVehicle.set(key, policy);
  }
  return listResult(
    rows.map((row) => ({
      ...vehicleDto(row),
      currentDriverName: names.get(String(row.currentDriverId)) ?? null,
      insurance: insuranceDto(insuranceByVehicle.get(String(row._id))),
    })),
    total,
    query,
  );
}

export async function exportVehicles(raw: Parameters<typeof listArgs>[0], res: import("express").Response) {
  const query = listArgs({ ...raw, page: 1, limit: 100 }, SORT, "plateNumber");
  const rows = await Vehicle.find(filterOf({ ...query, limit: 10000, skip: 0, page: 1 })).sort(query.sort).limit(10000).lean();
  const drivers = await Driver.find({ _id: { $in: rows.map((row) => row.currentDriverId).filter(Boolean) } }).select("name").lean();
  const names = new Map(drivers.map((driver) => [String(driver._id), driver.name]));
  await writeXlsx(
    res,
    "vehicles.xlsx",
    [
      { header: "Vehicle name", key: "name" },
      { header: "Vehicle number", key: "plateNumber" },
      { header: "Company", key: "make" },
      { header: "Model", key: "model" },
      { header: "Year", key: "year" },
      { header: "Color", key: "color" },
      { header: "Fuel type", key: "fuelType" },
      { header: "VIN", key: "vin" },
      { header: "Type", key: "type" },
      { header: "Ownership", key: "ownership" },
      { header: "Odometer (km)", key: "odometerKm" },
      { header: "Status", key: "status" },
      { header: "Driver", key: "driver" },
    ],
    rows.map((row) => ({
      name: row.name ?? "",
      plateNumber: row.plateNumber,
      make: row.make,
      model: row.modelName,
      year: row.year,
      color: row.color,
      fuelType: statusDto(row.fuelType || "petrol").label,
      vin: row.vin,
      type: statusDto(row.type).label,
      ownership: statusDto(row.ownership).label,
      odometerKm: row.odometerKm,
      status: statusDto(row.status).label,
      driver: names.get(String(row.currentDriverId)) ?? "",
    })),
  );
}

export async function getVehicle(id: string) {
  const vehicle = await Vehicle.findById(id).lean();
  if (!vehicle) throw notFound("Vehicle");
  const [driver, istimara, policy, schedules] = await Promise.all([
    vehicle.currentDriverId ? Driver.findById(vehicle.currentDriverId).select("name mobileLast4").lean() : null,
    Istimara.findOne({ vehicleId: vehicle._id }).sort({ expiryDate: -1 }).lean(),
    InsurancePolicy.findOne({ vehicleId: vehicle._id }).sort({ endDate: -1 }).lean(),
    MaintenanceSchedule.find({ vehicleId: vehicle._id }).lean(),
  ]);
  return {
    ...vehicleDto(vehicle),
    currentDriver: driver
      ? { id: String(driver._id), name: driver.name, mobileMasked: `***** ${driver.mobileLast4}` }
      : null,
    istimara: istimara
      ? {
          id: String(istimara._id),
          number: istimara.number,
          expiryDate: dateDto(istimara.expiryDate),
          status: statusDto(expiryStatus(istimara.expiryDate)),
        }
      : null,
    insurance: policy
      ? {
          id: String(policy._id),
          policyNumber: policy.policyNumber,
          insurer: policy.insurer,
          startDate: dateDto(policy.startDate),
          endDate: dateDto(policy.endDate),
          status: statusDto(expiryStatus(policy.endDate)),
        }
      : null,
    maintenance: schedules.map((schedule) => ({
      id: String(schedule._id),
      serviceType: schedule.serviceType,
      nextDueDate: dateDto(schedule.nextDueDate),
      nextDueKm: schedule.nextDueKm,
      status: statusDto(
        maintenanceStatus({
          nextDueDate: schedule.nextDueDate,
          nextDueKm: schedule.nextDueKm,
          odometerKm: vehicle.odometerKm,
        }),
      ),
    })),
  };
}

export async function createVehicle(input: VehicleInput) {
  await assertCapacity(1);
  try {
    const vehicle = await Vehicle.create({
      name: input.name?.trim() || `${input.make} ${input.model}`,
      plateNumber: input.plateNumber.toUpperCase(),
      make: input.make,
      modelName: input.model,
      fuelType: input.fuelType ?? "petrol",
      platePhotoId: input.platePhotoId,
      vehiclePhotoId: input.vehiclePhotoId,
      photoIds: (input.photoIds ?? []).map((id) => new Types.ObjectId(id)),
      note: input.note ?? "",
      year: input.year,
      color: input.color,
      vin: input.vin.toUpperCase(),
      type: input.type,
      ownership: input.ownership,
      odometerKm: input.odometerKm,
      pucExpiry: optionalDate(input.pucExpiry, "Pollution (PUC) expiry"),
      fitnessExpiry: optionalDate(input.fitnessExpiry, "Fitness certificate expiry"),
      status: input.status ?? "active",
    });
    await saveInsurance(vehicle._id, input.insuranceStart, input.insuranceEnd, vehicle.plateNumber);
    return vehicleDto(vehicle);
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(409, "DUPLICATE", "Plate number or VIN already exists");
    throw error;
  }
}

export async function updateVehicle(id: string, input: Partial<VehicleInput>) {
  const vehicle = await Vehicle.findById(id);
  if (!vehicle) throw notFound("Vehicle");
  if (input.name != null) vehicle.name = input.name;
  if (input.plateNumber) vehicle.plateNumber = input.plateNumber.toUpperCase();
  if (input.make) vehicle.make = input.make;
  if (input.fuelType) vehicle.fuelType = input.fuelType;
  if (input.platePhotoId) vehicle.platePhotoId = new Types.ObjectId(input.platePhotoId);
  if (input.vehiclePhotoId) vehicle.vehiclePhotoId = new Types.ObjectId(input.vehiclePhotoId);
  if (input.photoIds) vehicle.photoIds = input.photoIds.map((id) => new Types.ObjectId(id));
  if (input.note != null) vehicle.note = input.note;
  if (input.model) vehicle.modelName = input.model;
  if (input.year) vehicle.year = input.year;
  if (input.color) vehicle.color = input.color;
  if (input.vin) vehicle.vin = input.vin.toUpperCase();
  if (input.type) vehicle.type = input.type;
  if (input.ownership) vehicle.ownership = input.ownership;
  if (input.odometerKm != null) vehicle.odometerKm = input.odometerKm;
  if (input.pucExpiry !== undefined) vehicle.pucExpiry = optionalDate(input.pucExpiry, "Pollution (PUC) expiry");
  if (input.fitnessExpiry !== undefined) vehicle.fitnessExpiry = optionalDate(input.fitnessExpiry, "Fitness certificate expiry");
  if (input.status) vehicle.status = input.status;
  try {
    await vehicle.save();
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(409, "DUPLICATE", "Plate number or VIN already exists");
    throw error;
  }
  await saveInsurance(vehicle._id, input.insuranceStart, input.insuranceEnd, vehicle.plateNumber);
  return vehicleDto(vehicle);
}

function optionalDate(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(400, "VALIDATION_ERROR", `Enter a valid ${label} date`);
  return date;
}

async function saveInsurance(vehicleId: unknown, start: string | undefined, end: string | undefined, plate: string) {
  if (!start || !end) return;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new AppError(400, "VALIDATION_ERROR", "Enter a valid insurance start and expiry date");
  }
  if (endDate < startDate) throw new AppError(400, "VALIDATION_ERROR", "Insurance expiry must be on or after the start date");
  const latest = await InsurancePolicy.findOne({ vehicleId }).sort({ endDate: -1 });
  if (latest) {
    latest.startDate = startDate;
    latest.endDate = endDate;
    await latest.save();
    return;
  }
  await InsurancePolicy.create({
    vehicleId,
    policyNumber: plate || "Policy",
    insurer: "Insurer",
    type: "comprehensive",
    startDate,
    endDate,
    premiumHalalas: 0,
  });
}

export async function deleteVehicle(id: string) {
  const vehicle = await Vehicle.findById(id);
  if (!vehicle) throw notFound("Vehicle");
  await Assignment.updateMany({ vehicleId: vehicle._id, endDate: null }, { endDate: new Date() });
  await vehicle.deleteOne();
  return { id };
}

export async function bumpOdometer(vehicleId: string, km: number, session?: ClientSession) {
  await Vehicle.updateOne({ _id: vehicleId, odometerKm: { $lt: km } }, { $set: { odometerKm: km } }, { session });
}

export async function importTemplate() {
  return workbookBuffer(
    ["name", "plateNumber", "make", "model", "year", "color", "fuelType", "vin", "type", "ownership", "odometerKm"],
    [["Hilux", "ABC1234", "Toyota", "Hilux", "2022", "White", "diesel", "JTFHX02P000000001", "pickup", "owned", "45000"]],
  );
}

export async function previewImport(buffer: Buffer) {
  const sheetRows = await readSheetRows(buffer);
  if (sheetRows.length === 0) throw new AppError(400, "EMPTY_FILE", "The spreadsheet has no data rows");
  if (sheetRows.length > 500) throw new AppError(400, "TOO_MANY_ROWS", "Import up to 500 vehicles at a time");
  const seenPlates = new Set<string>();
  const seenVins = new Set<string>();
  const rows = sheetRows.map((row, index) => {
    const parsed = vehicleBody.safeParse({ ...row, status: "active" });
    const errors: string[] = [];
    if (!parsed.success) {
      errors.push(...parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
      return { rowNumber: index + 2, data: row, errors };
    }
    const plate = parsed.data.plateNumber.toUpperCase();
    const vin = parsed.data.vin.toUpperCase();
    if (seenPlates.has(plate)) errors.push("Duplicate plate in the file");
    if (seenVins.has(vin)) errors.push("Duplicate VIN in the file");
    seenPlates.add(plate);
    seenVins.add(vin);
    return { rowNumber: index + 2, data: parsed.data, errors };
  });
  const plates = rows.filter((row) => row.errors.length === 0).map((row) => String((row.data as VehicleInput).plateNumber).toUpperCase());
  const vins = rows.filter((row) => row.errors.length === 0).map((row) => String((row.data as VehicleInput).vin).toUpperCase());
  const existing = await Vehicle.find({ $or: [{ plateNumber: { $in: plates } }, { vin: { $in: vins } }] })
    .select("plateNumber vin")
    .lean();
  const plateSet = new Set(existing.map((item) => item.plateNumber));
  const vinSet = new Set(existing.map((item) => item.vin));
  for (const row of rows) {
    if (row.errors.length) continue;
    const data = row.data as VehicleInput;
    if (plateSet.has(data.plateNumber.toUpperCase())) row.errors.push("Plate number already exists");
    if (vinSet.has(data.vin.toUpperCase())) row.errors.push("VIN already exists");
  }
  const validCount = rows.filter((row) => row.errors.length === 0).length;
  try {
    await assertCapacity(validCount);
  } catch (error) {
    if (error instanceof AppError && error.code === "VEHICLE_LIMIT") {
      for (const row of rows) if (row.errors.length === 0) row.errors.push(error.message);
    } else throw error;
  }
  const batch = await ImportBatch.create({
    rows,
    status: "preview",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return {
    importId: String(batch._id),
    total: rows.length,
    valid: rows.filter((row) => row.errors.length === 0).length,
    invalid: rows.filter((row) => row.errors.length > 0).length,
    rows,
  };
}

export async function commitImport(id: string) {
  const batch = await ImportBatch.findById(id);
  if (!batch || batch.status !== "preview") throw notFound("Import");
  const invalid = (batch.rows as Array<{ errors: string[] }>).filter((row) => row.errors.length > 0);
  if (invalid.length > 0) throw new AppError(400, "IMPORT_INVALID", "Fix the spreadsheet errors before importing");
  const rows = batch.rows as Array<{ data: VehicleInput }>;
  await assertCapacity(rows.length);
  await withTransaction(async (session) => {
    for (const row of rows) {
      await Vehicle.create(
        [
          {
            name: row.data.name?.trim() || `${row.data.make} ${row.data.model}`,
            plateNumber: row.data.plateNumber.toUpperCase(),
            make: row.data.make,
            modelName: row.data.model,
            fuelType: row.data.fuelType ?? "petrol",
            year: row.data.year,
            color: row.data.color,
            vin: row.data.vin.toUpperCase(),
            type: row.data.type,
            ownership: row.data.ownership,
            odometerKm: row.data.odometerKm,
            status: "active",
          },
        ],
        { session },
      );
    }
    batch.status = "committed";
    await batch.save({ session });
  });
  return { imported: rows.length };
}
