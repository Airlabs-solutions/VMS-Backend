import { Types } from "mongoose";
import { LICENSE_TYPES } from "../../config/constants";
import { getCtx } from "../../lib/context";
import { AppError, notFound } from "../../lib/errors";
import { dateDto, moneyDto, statusDto } from "../../lib/present";
import { expiryStatus, maintenanceStatus } from "../../lib/status";
import { decryptField, encryptField, hmacField } from "../../lib/crypto";
import { assertMobileAvailable } from "../../lib/mobileUnique";
import { formatSaudiMobile, normalizeSaudiMobile } from "../../lib/phone";
import { isDuplicateKey } from "../../lib/tenantPlugin";
import { activeVehicleForDriver, getDriver } from "../drivers/service";
import { Driver } from "../drivers/model";
import { Alert } from "../alerts/model";
import { saveUpload, signedUrl } from "../files/service";
import { InsurancePolicy } from "../insurance/model";
import { Istimara } from "../istimara/model";
import { MaintenanceSchedule } from "../maintenance/model";
import { fileUrlForDriver, listForDriver, replyToAdmin, unreadForDriver } from "../messages/service";
import { createFuel, createTrip, fuelBody, tripBody } from "../operations/service";
import { FuelLog, Violation } from "../operations/model";
import { User } from "../users/model";

async function requireDriverId() {
  const ctx = getCtx();
  if (ctx.driverId) return ctx.driverId;
  if (ctx.userId) {
    const user = await User.findById(ctx.userId).select("driverId").lean();
    if (user?.driverId) {
      ctx.driverId = String(user.driverId);
      return ctx.driverId;
    }
  }
  throw new AppError(403, "FORBIDDEN", "No driver profile is linked to this account");
}

const PROFILE_CHECKS: Array<[string, (profile: ProfileShape) => boolean]> = [
  ["Name", (profile) => Boolean(profile.name?.trim())],
  ["Mobile", (profile) => Boolean(profile.mobile)],
  ["Profile photo", (profile) => Boolean(profile.photoUrl)],
  ["Iqama number", (profile) => /^\d{10}$/.test(profile.iqamaNumber ?? "")],
  ["Iqama expiry", (profile) => Boolean(profile.iqamaExpiry)],
  ["License number", (profile) => Boolean(profile.licenseNumber?.trim())],
  ["License type", (profile) => Boolean(profile.licenseType?.code)],
  ["License expiry", (profile) => Boolean(profile.licenseExpiry)],
];

type ProfileShape = {
  name?: string | null;
  mobile?: string | null;
  photoUrl?: string | null;
  iqamaNumber?: string | null;
  iqamaExpiry?: string | null;
  licenseNumber?: string | null;
  licenseType?: { code?: string } | null;
  licenseExpiry?: string | null;
};

function profileProgress(profile: ProfileShape) {
  const missing = PROFILE_CHECKS.filter(([, check]) => !check(profile)).map(([label]) => label);
  const completion = Math.round(((PROFILE_CHECKS.length - missing.length) / PROFILE_CHECKS.length) * 100);
  return { completion, missing, complete: missing.length === 0 };
}

async function requireVerifiedProfile() {
  const driver = await Driver.findById(await requireDriverId()).select("profileVerifiedAt").lean();
  if (!driver?.profileVerifiedAt) {
    throw new AppError(403, "PROFILE_INCOMPLETE", "Complete and verify your profile before opening this page");
  }
}

function earlierDate(left?: Date | null, right?: Date | null) {
  const dates = [left, right].filter((value): value is Date => Boolean(value));
  if (!dates.length) return null;
  return dates.reduce((soonest, value) => (value.getTime() < soonest.getTime() ? value : soonest));
}

function reminder(title: string, date: Date | null | undefined) {
  if (!date) return { title, date: null, status: null };
  return { title, date: dateDto(date), status: statusDto(expiryStatus(date)) };
}

export async function myVehicle() {
  await requireVerifiedProfile();
  const driverId = await requireDriverId();
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
        reminder("Fahas", null),
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
      reminder("Fahas", earlierDate(vehicle.pucExpiry, vehicle.fitnessExpiry)),
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

function alertDto(alert: { _id: unknown; type?: string; message: string; dueDate?: Date | null; createdAt?: Date }) {
  return {
    id: String(alert._id),
    type: alert.type ?? "",
    message: alert.message,
    dueDate: dateDto(alert.dueDate),
    createdAt: dateDto(alert.createdAt),
  };
}

export async function myProfile() {
  const driverId = await requireDriverId();
  const [driver, record] = await Promise.all([
    getDriver(driverId),
    Driver.findById(driverId).select("photoId employeeId profileVerifiedAt").lean(),
  ]);
  let photoUrl: string | null = null;
  if (record?.photoId) {
    try {
      photoUrl = (await signedUrl(String(record.photoId))).url;
    } catch {
      photoUrl = null;
    }
  }
  const profile = {
    name: driver.name,
    mobile: driver.mobile ?? null,
    driverId: record?.employeeId || driver.employeeId || driver.id,
    employeeId: driver.employeeId ?? "",
    licenseNumber: driver.licenseNumber ?? null,
    licenseType: driver.licenseType,
    licenseExpiry: driver.licenseExpiry,
    licenseStatus: driver.licenseStatus,
    iqamaNumber: driver.iqamaNumber ?? null,
    iqamaExpiry: driver.iqamaExpiry,
    iqamaStatus: driver.iqamaStatus,
    photoUrl,
    verified: Boolean(record?.profileVerifiedAt),
  };
  const progress = profileProgress(profile);
  if (progress.complete && !record?.profileVerifiedAt) {
    await Driver.updateOne({ _id: driverId }, { $set: { profileVerifiedAt: new Date() } });
    profile.verified = true;
  }
  return { ...profile, ...progress };
}

export async function updateMyProfile(body: {
  name?: string;
  mobile?: string;
  iqamaNumber?: string;
  iqamaExpiry?: string;
  licenseNumber?: string;
  licenseType?: (typeof LICENSE_TYPES)[number];
  licenseExpiry?: string;
}) {
  const driverId = await requireDriverId();
  const driver = await Driver.findById(driverId);
  if (!driver) throw notFound("Driver");
  if (body.name) driver.name = body.name;
  if (body.mobile) {
    const mobile = normalizeSaudiMobile(body.mobile);
    await assertMobileAvailable(mobile, { driverId: String(driver._id) });
    driver.mobileEnc = encryptField(mobile);
    driver.mobileHash = hmacField(mobile);
    driver.mobileLast4 = mobile.slice(-4);
  }
  if (body.iqamaNumber) {
    driver.iqamaEnc = encryptField(body.iqamaNumber);
    driver.iqamaHash = hmacField(body.iqamaNumber);
  }
  if (body.iqamaExpiry) driver.iqamaExpiry = parseProfileDate(body.iqamaExpiry, "Iqama expiry");
  if (body.licenseNumber) driver.licenseNumberEnc = encryptField(body.licenseNumber);
  if (body.licenseType) driver.licenseType = body.licenseType;
  if (body.licenseExpiry) driver.licenseExpiry = parseProfileDate(body.licenseExpiry, "License expiry");
  try {
    await driver.save();
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(409, "DUPLICATE", "Mobile or iqama is already in use");
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
    if (isDuplicateKey(error)) throw new AppError(409, "DUPLICATE", "Mobile or iqama is already in use");
    throw error;
  }
  return myProfile();
}

export async function verifyMyProfile() {
  const driverId = await requireDriverId();
  const profile = await myProfile();
  if (!profile.complete) {
    throw new AppError(400, "PROFILE_INCOMPLETE", "Fill in every required detail, including a profile photo, before verification");
  }
  const driver = await Driver.findById(driverId);
  if (!driver) throw notFound("Driver");
  driver.profileVerifiedAt = new Date();
  await driver.save();
  return myProfile();
}

function parseProfileDate(value: string, label: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(400, "VALIDATION_ERROR", `Enter a valid ${label} date`);
  return date;
}

export async function uploadMyPhoto(file: Express.Multer.File | undefined) {
  const driverId = await requireDriverId();
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
  await requireVerifiedProfile();
  return listForDriver(await requireDriverId());
}

export async function myUnread() {
  return unreadForDriver(await requireDriverId());
}

export async function myMessageFile(fileId: string) {
  await requireVerifiedProfile();
  return fileUrlForDriver(await requireDriverId(), fileId);
}

export async function uploadMyMessageFile(file: Express.Multer.File | undefined) {
  await requireVerifiedProfile();
  await requireDriverId();
  if (!file) throw new AppError(400, "INVALID_FILE", "Choose a file to upload");
  if (file.size > 10 * 1024 * 1024) throw new AppError(400, "INVALID_FILE", "This file is larger than 10 MB");
  const name = (file.originalname || "").toLowerCase();
  const jpeg = file.buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const png = file.buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const pdf = file.buffer.subarray(0, 4).toString("ascii") === "%PDF";
  const audio = /\.(webm|ogg|mp3|m4a|wav|aac)$/.test(name);
  if (!jpeg && !png && !pdf && !audio) throw new AppError(400, "INVALID_FILE", "Use a JPG, PNG, PDF, or a voice note.");
  return saveUpload(file, "messages");
}

export async function myReply(body: string, fileIds: string[] = []) {
  await requireVerifiedProfile();
  return replyToAdmin(await requireDriverId(), body, fileIds);
}

export async function myViolations() {
  await requireVerifiedProfile();
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
  await requireVerifiedProfile();
  const parsed = fuelBody.omit({ vehicleId: true, driverId: true, approvalStatus: true }).parse(input);
  const driverId = getCtx().driverId;
  if (!driverId) throw new AppError(403, "FORBIDDEN", "No driver profile is linked to this account");
  const vehicle = await activeVehicleForDriver(driverId);
  if (!vehicle) throw notFound("Assigned vehicle");
  return createFuel({ ...parsed, vehicleId: String(vehicle._id), driverId }, "pending");
}

export async function myTrip(input: unknown) {
  await requireVerifiedProfile();
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
