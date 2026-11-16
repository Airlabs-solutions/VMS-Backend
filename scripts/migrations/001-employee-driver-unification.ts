import mongoose from "mongoose";
import { Employee } from "../../src/core/employees/model";
import { Driver } from "../../src/modules/drivers/model";
import { logger } from "../../src/lib/logger";

export async function up(): Promise<void> {
  const drivers = await Driver.find({}).setOptions({ skipTenant: true });
  logger.info({ count: drivers.length }, "Migrating drivers to unified employees...");

  for (const driver of drivers) {
    if (driver.employeeRef) continue;

    const employeeNumber = driver.employeeId || `EMP-${driver._id.toString().slice(-6).toUpperCase()}`;

    let employee = await Employee.findOne({
      companyId: driver.companyId,
      iqamaHash: driver.iqamaHash,
    }).setOptions({ skipTenant: true });

    if (!employee) {
      employee = await Employee.create({
        companyId: driver.companyId,
        employeeNumber,
        nameEn: driver.name,
        mobileEnc: driver.mobileEnc,
        mobileHash: driver.mobileHash,
        mobileLast4: driver.mobileLast4,
        iqamaEnc: driver.iqamaEnc,
        iqamaHash: driver.iqamaHash,
        iqamaExpiry: driver.iqamaExpiry,
        employmentStatus: driver.status === "active" ? "active" : "terminated",
        joinDate: driver.createdAt || new Date(),
        photoId: driver.photoId,
      });
    }

    driver.employeeRef = employee._id;
    if (!driver.employeeId) driver.employeeId = employeeNumber;
    await driver.save();
  }

  logger.info("Driver to Employee unification migration complete");
}

export async function down(): Promise<void> {
  logger.info("Rolling back Driver to Employee unification...");
  await Driver.updateMany({}, { $unset: { employeeRef: "" } }).setOptions({ skipTenant: true });
  logger.info("Rollback complete");
}
