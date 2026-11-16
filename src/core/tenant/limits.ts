import mongoose from "mongoose";
import { AppError } from "../../lib/errors";
import { Employee } from "../employees/model";
import { Company } from "../../modules/companies/model";
import { User } from "../../modules/users/model";
import { Vehicle } from "../../modules/vehicles/model";

export type LimitResource = "vehicles" | "equipment" | "employees" | "adminSeats";

export async function assertWithinLimit(companyId: string, resource: LimitResource): Promise<void> {
  const company = await Company.findById(companyId).select("limits maxVehicles").lean();
  if (!company) {
    throw new AppError(404, "NOT_FOUND", "Company was not found");
  }

  const limits = company.limits || {
    vehicles: company.maxVehicles || 500,
    equipment: 200,
    employees: 500,
    adminSeats: 5,
    smsCredits: 0,
    storageMb: 5120,
  };

  if (resource === "vehicles") {
    const currentVehicles = await Vehicle.countDocuments({
      companyId,
      status: { $ne: "sold" },
    }).setOptions({ skipTenant: true });
    if (currentVehicles >= limits.vehicles) {
      throw new AppError(
        400,
        "LIMIT_EXCEEDED",
        `You have reached your limit of ${limits.vehicles} active vehicles. Please upgrade your subscription limit.`,
      );
    }
  }

  if (resource === "employees") {
    const cap = limits.employees > 0 ? limits.employees : 500;
    const currentEmployees = await Employee.countDocuments({
      companyId,
      employmentStatus: { $ne: "terminated" },
    }).setOptions({ skipTenant: true });
    if (currentEmployees >= cap) {
      throw new AppError(
        400,
        "LIMIT_EXCEEDED",
        `You have reached your limit of ${cap} active employees. Please upgrade your subscription limit.`,
      );
    }
  }

  if (resource === "equipment") {
    const cap = limits.equipment > 0 ? limits.equipment : 200;
    const EquipmentModel = mongoose.models.Equipment;
    if (EquipmentModel) {
      const currentEquipment = await EquipmentModel.countDocuments({
        companyId,
        status: { $ne: "sold" },
      }).setOptions({ skipTenant: true });
      if (currentEquipment >= cap) {
        throw new AppError(
          400,
          "LIMIT_EXCEEDED",
          `You have reached your limit of ${cap} active equipment assets. Please upgrade your subscription limit.`,
        );
      }
    }
  }

  if (resource === "adminSeats") {
    const currentAdmins = await User.countDocuments({
      companyId,
      status: "active",
      role: { $ne: "driver" },
    });
    if (currentAdmins >= limits.adminSeats) {
      throw new AppError(
        400,
        "LIMIT_EXCEEDED",
        `You have reached your limit of ${limits.adminSeats} administrative seats.`,
      );
    }
  }
}

export async function validateLimitDowngrade(
  companyId: string,
  newVehiclesLimit?: number,
  force = false,
): Promise<void> {
  if (newVehiclesLimit === undefined || force) return;

  const currentVehicles = await Vehicle.countDocuments({
    companyId,
    status: { $ne: "sold" },
  }).setOptions({ skipTenant: true });

  if (newVehiclesLimit < currentVehicles) {
    throw new AppError(
      400,
      "LIMIT_BELOW_USAGE",
      `Cannot lower vehicle limit to ${newVehiclesLimit}. The company currently has ${currentVehicles} active vehicles. Confirm downgrade to proceed.`,
    );
  }
}
