import { Types } from "mongoose";
import { z } from "zod";
import { LICENSE_TYPES } from "../../config/constants";
import { requireCompanyId } from "../../lib/context";
import { decryptField, encryptField, hmacField } from "../../lib/crypto";
import { dateDto, statusDto } from "../../lib/present";
import { AppError, notFound } from "../../lib/errors";
import { escapeRegex, listArgs, listResult, writeXlsx } from "../../lib/pagination";
import { formatSaudiMobile, maskMobileLast4, normalizeSaudiMobile } from "../../lib/phone";
import { expiryStatus } from "../../lib/status";
import { isDuplicateKey, withTransaction } from "../../lib/tenantPlugin";
import { hashPassword } from "../auth/service";
import { User } from "../users/model";
import { bumpOdometer } from "../vehicles/service";
import { Vehicle } from "../vehicles/model";
import { Assignment, Driver, Handover } from "./model";

const SORT = ["name", "createdAt", "status"];

export const driverBody = z.object({
  name: z.string().trim().min(1).max(120),
  mobile: z.string().trim().min(7).max(24),
  employeeId: z.string().trim().max(40).optional().or(z.literal("")),
  iqamaNumber: z.string().trim().regex(/^\d{10}$/, "Iqama number must be 10 digits"),
  iqamaExpiry: z.coerce.date(),
  licenseNumber: z.string().trim().min(3).max(30),
  licenseType: z.enum(LICENSE_TYPES),
  licenseExpiry: z.coerce.date(),
  password: z.string().min(8).regex(/[A-Za-z]/).regex(/\d/).optional(),
  portalAccess: z.boolean().optional(),
  fileIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

function maskMobile(last4: string) {
  return maskMobileLast4(last4);
}

function driverDto(
  driver: {
    _id: unknown;
    name: string;
    mobileLast4: string;
    employeeId?: string | null;
    iqamaExpiry: Date;
    licenseType: string;
    licenseExpiry: Date;
    status: string;
    fileIds?: unknown[];
    createdAt?: Date;
  },
  reveal = false,
  secrets?: { mobile?: string; iqama?: string; license?: string },
) {
  return {
    id: String(driver._id),
    name: driver.name,
    mobileMasked: maskMobile(driver.mobileLast4),
    mobile: reveal ? secrets?.mobile ?? null : undefined,
    employeeId: driver.employeeId ?? "",
    iqamaMasked: "******",
    iqamaNumber: reveal ? secrets?.iqama ?? null : undefined,
    iqamaExpiry: dateDto(driver.iqamaExpiry),
    iqamaStatus: statusDto(expiryStatus(driver.iqamaExpiry)),
    licenseMasked: "******",
    licenseNumber: reveal ? secrets?.license ?? null : undefined,
    licenseType: statusDto(driver.licenseType),
    licenseExpiry: dateDto(driver.licenseExpiry),
    licenseStatus: statusDto(expiryStatus(driver.licenseExpiry)),
    status: statusDto(driver.status),
    fileIds: (driver.fileIds ?? []).map(String),
    createdAt: dateDto(driver.createdAt),
  };
}

export async function listDrivers(raw: Parameters<typeof listArgs>[0]) {
  const query = listArgs(raw, SORT, "name");
  const filter: Record<string, unknown> = {};
  if (query.filter.status) filter.status = query.filter.status;
  if (query.q) {
    if (/^\d{10}$/.test(query.q)) filter.iqamaHash = hmacField(query.q);
    else filter.name = new RegExp(escapeRegex(query.q), "i");
  }
  const [rows, total] = await Promise.all([
    Driver.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    Driver.countDocuments(filter),
  ]);
  const assignments = await Assignment.find({ driverId: { $in: rows.map((row) => row._id) }, endDate: null }).select("driverId vehicleId").lean();
  const vehicles = await Vehicle.find({ _id: { $in: assignments.map((row) => row.vehicleId) } }).select("plateNumber name").lean();
  const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));
  const vehicleByDriver = new Map(assignments.map((row) => [String(row.driverId), vehicleById.get(String(row.vehicleId)) ?? null]));
  return listResult(
    rows.map((row) => {
      const vehicle = vehicleByDriver.get(String(row._id));
      return {
        ...driverDto(row),
        assignedVehicle: vehicle ? { id: String(vehicle._id), plateNumber: vehicle.plateNumber, name: vehicle.name ?? "" } : null,
      };
    }),
    total,
    query,
  );
}

export async function exportDrivers(raw: Parameters<typeof listArgs>[0], res: import("express").Response) {
  const listed = await listDrivers({ ...raw, page: 1, limit: 100 });
  const rows = await Driver.find().sort({ name: 1 }).limit(10000).lean();
  await writeXlsx(
    res,
    "drivers.xlsx",
    [
      { header: "Name", key: "name" },
      { header: "Mobile", key: "mobile" },
      { header: "Employee ID", key: "employeeId" },
      { header: "Iqama expiry", key: "iqamaExpiry" },
      { header: "Iqama status", key: "iqamaStatus" },
      { header: "License type", key: "licenseType" },
      { header: "License expiry", key: "licenseExpiry" },
      { header: "License status", key: "licenseStatus" },
      { header: "Status", key: "status" },
    ],
    rows.map((row) => {
      const dto = driverDto(row);
      return {
        name: dto.name,
        mobile: dto.mobileMasked,
        employeeId: dto.employeeId,
        iqamaExpiry: dto.iqamaExpiry ? new Date(dto.iqamaExpiry).toLocaleDateString("en-GB") : "",
        iqamaStatus: dto.iqamaStatus.label,
        licenseType: dto.licenseType.label,
        licenseExpiry: dto.licenseExpiry ? new Date(dto.licenseExpiry).toLocaleDateString("en-GB") : "",
        licenseStatus: dto.licenseStatus.label,
        status: dto.status.label,
      };
    }),
  );
  return listed;
}

export async function getDriver(id: string) {
  const driver = await Driver.findById(id).lean();
  if (!driver) throw notFound("Driver");
  const assignment = await Assignment.findOne({ driverId: id, endDate: null }).lean();
  const vehicle = assignment ? await Vehicle.findById(assignment.vehicleId).select("plateNumber make modelName").lean() : null;
  const portalUser = await User.findOne({ driverId: driver._id, role: "driver", status: "active" }).select("_id").lean();
  return {
    ...driverDto(driver, true, {
      mobile: formatSaudiMobile(decryptField(driver.mobileEnc)),
      iqama: decryptField(driver.iqamaEnc),
      license: decryptField(driver.licenseNumberEnc),
    }),
    portalAccess: Boolean(portalUser),
    currentVehicle: vehicle
      ? { id: String(vehicle._id), plateNumber: vehicle.plateNumber, make: vehicle.make, model: vehicle.modelName }
      : null,
  };
}

export async function createDriver(input: z.infer<typeof driverBody>) {
  const companyId = requireCompanyId();
  const mobile = normalizeSaudiMobile(input.mobile);
  const mobileHash = hmacField(mobile);
  const iqamaHash = hmacField(input.iqamaNumber);
  try {
    const driver = await Driver.create({
      name: input.name,
      mobileEnc: encryptField(mobile),
      mobileHash,
      mobileLast4: mobile.slice(-4),
      employeeId: input.employeeId || undefined,
      iqamaEnc: encryptField(input.iqamaNumber),
      iqamaHash,
      iqamaExpiry: input.iqamaExpiry,
      licenseNumberEnc: encryptField(input.licenseNumber),
      licenseType: input.licenseType,
      licenseExpiry: input.licenseExpiry,
      fileIds: (input.fileIds ?? []).map((id) => new Types.ObjectId(id)),
      status: input.status ?? "active",
    });
    if (input.portalAccess) {
      await User.create({
        companyId,
        role: "driver",
        name: input.name,
        mobileEnc: encryptField(mobile),
        mobileHash,
        mobileLast4: mobile.slice(-4),
        passwordHash: input.password ? await hashPassword(input.password) : undefined,
        driverId: driver._id,
        status: input.status ?? "active",
      });
    }
    return driverDto(driver);
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(409, "DUPLICATE", "Mobile or iqama is already in use");
    throw error;
  }
}

export async function updateDriver(id: string, input: Partial<z.infer<typeof driverBody>> & { status?: "active" | "inactive" }) {
  const driver = await Driver.findById(id);
  if (!driver) throw notFound("Driver");
  if (input.name) driver.name = input.name;
  if (input.employeeId != null) driver.employeeId = input.employeeId;
  if (input.iqamaExpiry) driver.iqamaExpiry = input.iqamaExpiry;
  if (input.licenseType) driver.licenseType = input.licenseType;
  if (input.licenseExpiry) driver.licenseExpiry = input.licenseExpiry;
  if (input.status) driver.status = input.status;
  if (input.iqamaNumber) {
    driver.iqamaEnc = encryptField(input.iqamaNumber);
    driver.iqamaHash = hmacField(input.iqamaNumber);
  }
  if (input.licenseNumber) driver.licenseNumberEnc = encryptField(input.licenseNumber);
  if (input.mobile) {
    const mobile = normalizeSaudiMobile(input.mobile);
    driver.mobileEnc = encryptField(mobile);
    driver.mobileHash = hmacField(mobile);
    driver.mobileLast4 = mobile.slice(-4);
  }
  if (input.fileIds) driver.fileIds = input.fileIds.map((fileId) => new Types.ObjectId(fileId));
  try {
    await driver.save();
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(409, "DUPLICATE", "Mobile or iqama is already in use");
    throw error;
  }
  if (input.portalAccess === true) {
    const existing = await User.findOne({ driverId: driver._id, role: "driver" });
    if (existing) {
      existing.name = driver.name;
      existing.status = driver.status === "inactive" ? "inactive" : "active";
      existing.mobileEnc = driver.mobileEnc;
      existing.mobileHash = driver.mobileHash;
      existing.mobileLast4 = driver.mobileLast4;
      await existing.save();
    } else {
      await User.create({
        companyId: requireCompanyId(),
        role: "driver",
        name: driver.name,
        mobileEnc: driver.mobileEnc,
        mobileHash: driver.mobileHash,
        mobileLast4: driver.mobileLast4,
        driverId: driver._id,
        status: driver.status === "inactive" ? "inactive" : "active",
      });
    }
  } else if (input.portalAccess === false) {
    await User.updateOne({ driverId: driver._id, role: "driver" }, { status: "inactive" });
  } else if (input.mobile || input.name || input.status) {
    await User.updateOne(
      { driverId: driver._id, role: "driver" },
      {
        name: driver.name,
        status: driver.status,
        mobileEnc: driver.mobileEnc,
        mobileHash: driver.mobileHash,
        mobileLast4: driver.mobileLast4,
      },
    );
  }
  return driverDto(driver.toObject());
}

export async function deleteDriver(id: string) {
  const driver = await Driver.findById(id);
  if (!driver) throw notFound("Driver");
  const open = await Assignment.find({ driverId: driver._id, endDate: null });
  for (const assignment of open) {
    assignment.endDate = new Date();
    await assignment.save();
    await Vehicle.updateOne({ _id: assignment.vehicleId, currentDriverId: driver._id }, { $unset: { currentDriverId: 1 } });
  }
  await User.deleteOne({ driverId: driver._id });
  await driver.deleteOne();
  return { id };
}

export async function assignDriver(
  driverId: string,
  input: { vehicleId: string; date: Date; odometerKm: number; fuelLevel?: string; notes?: string; fileIds?: string[] },
) {
  return withTransaction(async (session) => {
    const driver = await Driver.findById(driverId).session(session);
    const vehicle = await Vehicle.findById(input.vehicleId).session(session);
    if (!driver || driver.status !== "active") throw notFound("Driver");
    if (!vehicle) throw notFound("Vehicle");
    const driverAssignment = await Assignment.findOne({ driverId, endDate: null }).session(session);
    if (driverAssignment && String(driverAssignment.vehicleId) !== input.vehicleId) {
      throw new AppError(409, "DRIVER_ASSIGNED", "This driver is already assigned to another vehicle");
    }
    const vehicleAssignment = await Assignment.findOne({ vehicleId: input.vehicleId, endDate: null }).session(session);
    if (vehicleAssignment && String(vehicleAssignment.driverId) === driverId) {
      throw new AppError(409, "ALREADY_ASSIGNED", "This driver is already assigned to the vehicle");
    }
    if (vehicleAssignment) {
      vehicleAssignment.endDate = input.date;
      await vehicleAssignment.save({ session });
    }
    const created = await Assignment.create(
      [{ vehicleId: vehicle._id, driverId: driver._id, startDate: input.date, endDate: null }],
      { session },
    );
    if (vehicleAssignment) {
      await Handover.create(
        [
          {
            assignmentId: created[0]._id,
            vehicleId: vehicle._id,
            fromDriverId: vehicleAssignment.driverId,
            toDriverId: driver._id,
            date: input.date,
            odometerKm: input.odometerKm,
            fuelLevel: input.fuelLevel,
            notes: input.notes,
            fileIds: (input.fileIds ?? []).map((id) => new Types.ObjectId(id)),
          },
        ],
        { session },
      );
    }
    vehicle.currentDriverId = driver._id;
    if (input.odometerKm > vehicle.odometerKm) vehicle.odometerKm = input.odometerKm;
    await vehicle.save({ session });
    await bumpOdometer(String(vehicle._id), input.odometerKm, session);
    return { assignmentId: String(created[0]._id) };
  });
}

export async function unassignDriver(driverId: string, date: Date) {
  const assignment = await Assignment.findOne({ driverId, endDate: null });
  if (!assignment) throw new AppError(404, "NOT_FOUND", "This driver has no active assignment");
  assignment.endDate = date;
  await assignment.save();
  await Vehicle.updateOne({ _id: assignment.vehicleId, currentDriverId: driverId }, { $unset: { currentDriverId: 1 } });
  return { assignmentId: String(assignment._id) };
}

export async function listAssignments(vehicleId?: string, driverId?: string) {
  const filter: Record<string, unknown> = {};
  if (vehicleId) filter.vehicleId = vehicleId;
  if (driverId) filter.driverId = driverId;
  const rows = await Assignment.find(filter).sort({ startDate: -1 }).limit(200).lean();
  return rows.map((row) => ({
    id: String(row._id),
    vehicleId: String(row.vehicleId),
    driverId: String(row.driverId),
    startDate: dateDto(row.startDate),
    endDate: dateDto(row.endDate),
  }));
}

export async function listHandovers(vehicleId: string) {
  const rows = await Handover.find({ vehicleId }).sort({ date: -1 }).lean();
  return rows.map((row) => ({
    id: String(row._id),
    vehicleId: String(row.vehicleId),
    fromDriverId: row.fromDriverId ? String(row.fromDriverId) : null,
    toDriverId: String(row.toDriverId),
    date: dateDto(row.date),
    odometerKm: row.odometerKm,
    fuelLevel: row.fuelLevel ?? "",
    notes: row.notes ?? "",
    fileIds: (row.fileIds ?? []).map(String),
  }));
}

export async function driverForVehicleOnDate(vehicleId: string, date: Date) {
  const assignment = await Assignment.findOne({
    vehicleId,
    startDate: { $lte: date },
    $or: [{ endDate: null }, { endDate: { $gte: date } }],
  }).sort({ startDate: -1 });
  return assignment?.driverId ? String(assignment.driverId) : null;
}

export async function activeVehicleForDriver(driverId: string) {
  const assignment = await Assignment.findOne({ driverId, endDate: null }).lean();
  if (!assignment) return null;
  return Vehicle.findById(assignment.vehicleId);
}
