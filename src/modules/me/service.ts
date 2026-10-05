import { Types } from "mongoose";
import { getCtx } from "../../lib/context";
import { AppError, notFound } from "../../lib/errors";
import { dateDto, moneyDto, statusDto } from "../../lib/present";
import { expiryStatus, maintenanceStatus } from "../../lib/status";
import { decryptField, encryptField, hmacField } from "../../lib/crypto";
import { formatSaudiMobile, normalizeSaudiMobile } from "../../lib/phone";
import { isDuplicateKey } from "../../lib/tenantPlugin";
import { activeVehicleForDriver, getDriver } from "../drivers/service";
import { Driver } from "../drivers/model";
import { Alert } from "../alerts/model";
import { saveUpload, signedUrl } from "../files/service";
import { InsurancePolicy } from "../insurance/model";
import { Istimara } from "../istimara/model";
import { MaintenanceSchedule } from "../maintenance/model";
import { listForDriver, replyToAdmin, unreadForDriver } from "../messages/service";
import { createFuel, createTrip, fuelBody, tripBody } from "../operations/service";
import { FuelLog, Violation } from "../operations/model";
import { User } from "../users/model";

function requireDriverId() {
  const driverId = getCtx().driverId;
  if (!driverId) throw new AppError(403, "FORBIDDEN", "No driver profile is linked to this account");
  return driverId;
}

function reminder(title: string, date: Date | null | undefined) {
  if (!date) return { title, date: null, status: null };
  return { title, date: dateDto(date), status: statusDto(expiryStatus(date)) };
}

export async function myVehicle() {
  const driverId = requireDriverId();
  const [vehicle, driver] = await Promise.all([activeVehicleForDriver(driverId), getDriver(driverId)]);
  const documents = {
    licenseExpiry: driver.licenseExpiry,
    licenseStatus: driver.licenseStatus,
    iqamaExpiry: driver.iqamaExpiry,
    iqamaStatus: driver.iqamaStatus,
    licenseNumber: driver.licenseNumber,
    iqamaNumber: driver.iqamaNumber,
    mobile: driver.mobile,
  };
  const licenseReminder = reminder("Driver license", driver.licenseExpiry ? new Date(driver.licenseExpiry) : null);

  if (!vehicle) {
    const alerts = await Alert.find({ driverId, status: "open" }).sort({ createdAt: -1 }).limit(8).lean();
    return {
      assigned: false,
      plateNumber: null,
      make: null,
      model: null,
      year: null,
      color: null,
      fuelType: null,
      fuelLiters: null,
      odometerKm: null,
      insurance: null,
      reminders: [
        reminder("Insurance", null),
        reminder("Pollution (PUC)", null),
        reminder("Fitness certificate", null),
        licenseReminder,
      ],
      alerts: alerts.map(alertDto),
      istimaraExpiry: null,
      istimaraStatus: null,
      insuranceExpiry: null,
      insuranceStatus: null,
      nextService: null,
      documents,
    };
  }

  const [istimara, policy, schedules, fuel] = await Promise.all([
    Istimara.findOne({ vehicleId: vehicle._id }).sort({ expiryDate: -1 }).lean(),
    InsurancePolicy.findOne({ vehicleId: vehicle._id }).sort({ endDate: -1 }).lean(),
    MaintenanceSchedule.find({ vehicleId: vehicle._id }).lean(),
    FuelLog.findOne({ vehicleId: vehicle._id }).sort({ date: -1 }).select("liters").lean(),
  ]);
  const alerts = await Alert.find({
    status: "open",
    $or: [{ driverId }, { vehicleId: vehicle._id }],
  }).sort({ createdAt: -1 }).limit(8).lean();
  const nextService = schedules
    .map((schedule) => ({
      serviceType: schedule.serviceType,
      nextDueDate: dateDto(schedule.nextDueDate),
      nextDueKm: schedule.nextDueKm,
      status: statusDto(maintenanceStatus({ nextDueDate: schedule.nextDueDate, nextDueKm: schedule.nextDueKm, odometerKm: vehicle.odometerKm })),
    }))
    .sort((a, b) => (a.status.code === "overdue" ? -1 : 1))[0] ?? null;

  return {
    assigned: true,
    plateNumber: vehicle.plateNumber,
    make: vehicle.make,
    model: vehicle.modelName,
    year: vehicle.year,
    color: vehicle.color,
    fuelType: statusDto(vehicle.fuelType || "petrol"),
    fuelLiters: fuel ? fuel.liters : null,
    odometerKm: vehicle.odometerKm,
    insurance: policy
      ? {
          insurer: policy.insurer,
          policyNumber: policy.policyNumber,
          type: statusDto(policy.type),
          startDate: dateDto(policy.startDate),
          expiryDate: dateDto(policy.endDate),
          status: statusDto(expiryStatus(policy.endDate)),
        }
      : null,
    reminders: [
      reminder("Insurance", policy?.endDate),
      reminder("Pollution (PUC)", vehicle.pucExpiry),
      reminder("Fitness certificate", vehicle.fitnessExpiry),
      licenseReminder,
    ],
    alerts: alerts.map(alertDto),
    istimaraExpiry: istimara ? dateDto(istimara.expiryDate) : null,
    istimaraStatus: istimara ? statusDto(expiryStatus(istimara.expiryDate)) : null,
    insuranceExpiry: policy ? dateDto(policy.endDate) : null,
    insuranceStatus: policy ? statusDto(expiryStatus(policy.endDate)) : null,
    nextService,
    documents,
  };
}

function alertDto(alert: { _id: unknown; message: string; dueDate?: Date | null; createdAt?: Date }) {
  return {
    id: String(alert._id),
    message: alert.message,
    dueDate: dateDto(alert.dueDate),
    createdAt: dateDto(alert.createdAt),
  };
}

export async function myProfile() {
  const driverId = requireDriverId();
  const [driver, record] = await Promise.all([
    getDriver(driverId),
    Driver.findById(driverId).select("photoId employeeId").lean(),
  ]);
  let photoUrl: string | null = null;
  if (record?.photoId) {
    try {
      photoUrl = (await signedUrl(String(record.photoId))).url;
    } catch {
      photoUrl = null;
    }
  }
  return {
    name: driver.name,
    mobile: driver.mobile,
    driverId: record?.employeeId || driver.employeeId || driver.id,
    licenseNumber: driver.licenseNumber,
    licenseType: driver.licenseType,
    licenseExpiry: driver.licenseExpiry,
    licenseStatus: driver.licenseStatus,
    photoUrl,
  };
}

export async function updateMyProfile(body: { name?: string; mobile?: string }) {
  const driverId = requireDriverId();
  const driver = await Driver.findById(driverId);
  if (!driver) throw notFound("Driver");
  if (body.name) driver.name = body.name;
  if (body.mobile) {
    const mobile = normalizeSaudiMobile(body.mobile);
    driver.mobileEnc = encryptField(mobile);
    driver.mobileHash = hmacField(mobile);
    driver.mobileLast4 = mobile.slice(-4);
  }
  try {
    await driver.save();
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(409, "DUPLICATE", "This mobile number is already in use");
    throw error;
  }
  try {
    await User.updateOne(
      { driverId: driver._id },
      {
        name: driver.name,
        mobileEnc: driver.mobileEnc,
        mobileHash: driver.mobileHash,
        mobileLast4: driver.mobileLast4,
      },
    );
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(409, "DUPLICATE", "This mobile number is already in use");
    throw error;
  }
  return myProfile();
}

export async function uploadMyPhoto(file: Express.Multer.File | undefined) {
  const driverId = requireDriverId();
  if (!file) throw new AppError(400, "INVALID_FILE", "Choose a JPG or PNG photo");
  const jpeg = file.buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const png = file.buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (!jpeg && !png) throw new AppError(400, "INVALID_FILE", "Profile photo must be a JPG or PNG, up to 10 MB");
  const saved = await saveUpload(file, "drivers");
  const driver = await Driver.findById(driverId);
  if (!driver) throw notFound("Driver");
  driver.photoId = new Types.ObjectId(saved.id);
  await driver.save();
  return myProfile();
}

export async function myMessages() {
  return listForDriver(requireDriverId());
}

export async function myUnread() {
  return unreadForDriver(requireDriverId());
}

export async function myReply(body: string) {
  return replyToAdmin(requireDriverId(), body);
}

export async function myViolations() {
  const driverId = getCtx().driverId;
  if (!driverId) throw new AppError(403, "FORBIDDEN", "No driver profile is linked to this account");
  const rows = await Violation.find({ driverId }).sort({ date: -1 }).limit(100).lean();
  return rows.map((row) => ({
    id: String(row._id),
    number: row.number,
    date: dateDto(row.date),
    type: row.type,
    amount: moneyDto(row.amountHalalas),
    status: statusDto(row.status),
  }));
}

export async function myFuel(input: unknown) {
  const parsed = fuelBody.omit({ vehicleId: true, driverId: true, approvalStatus: true }).parse(input);
  const driverId = getCtx().driverId;
  if (!driverId) throw new AppError(403, "FORBIDDEN", "No driver profile is linked to this account");
  const vehicle = await activeVehicleForDriver(driverId);
  if (!vehicle) throw notFound("Assigned vehicle");
  return createFuel({ ...parsed, vehicleId: String(vehicle._id), driverId }, "pending");
}

export async function myTrip(input: unknown) {
  const parsed = tripBody.omit({ vehicleId: true, driverId: true }).parse(input);
  const driverId = getCtx().driverId;
  if (!driverId) throw new AppError(403, "FORBIDDEN", "No driver profile is linked to this account");
  const vehicle = await activeVehicleForDriver(driverId);
  if (!vehicle) throw notFound("Assigned vehicle");
  return createTrip({ ...parsed, vehicleId: String(vehicle._id), driverId });
}

export async function myProfileContact() {
  const driverId = getCtx().driverId;
  if (!driverId) return null;
  const { Driver } = await import("../drivers/model");
  const driver = await Driver.findById(driverId).lean();
  if (!driver) return null;
  return formatSaudiMobile(decryptField(driver.mobileEnc));
}
