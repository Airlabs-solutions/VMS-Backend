import { randomUUID } from "node:crypto";
import { ALERT_TYPES, type Module } from "../config/constants";
import { DOCUMENT_TYPE_REGISTRY, type DocumentTypeDefinition } from "../core/documents/registry";
import { ComplianceDocument } from "../core/documents/model";
import { requestContext } from "../lib/context";
import { daysBetween, formatDisplayDate } from "../lib/dates";
import { logger } from "../lib/logger";
import { matchingOffset } from "../lib/status";
import { AlertRule, JobLock } from "../modules/alerts/model";
import { raiseAlert, retryFailedSms, sendAlertSms } from "../modules/alerts/service";
import { emiMessage, expiryMessage, maintenanceDateMessage, maintenanceKmMessage } from "../modules/alerts/templates";
import { Company } from "../modules/companies/model";
import { Driver } from "../modules/drivers/model";
import { Assignment } from "../modules/drivers/model";
import { EmiInstallment } from "../modules/emi/model";
import { InsurancePolicy } from "../modules/insurance/model";
import { Istimara } from "../modules/istimara/model";
import { MaintenanceSchedule } from "../modules/maintenance/model";
import { Vehicle } from "../modules/vehicles/model";
import { EmploymentContract } from "../modules/hr/model";
import { Employee } from "../core/employees/model";
import { Equipment, EquipmentInspection, EquipmentMobilization } from "../modules/equipment/model";

async function withLock(name: string, fn: () => Promise<void>) {
  const owner = randomUUID();
  const now = new Date();
  const current = await JobLock.findOneAndUpdate(
    { name, lockedUntil: { $lte: now } },
    { $set: { lockedUntil: new Date(Date.now() + 30 * 60 * 1000), owner } },
    { new: true },
  );
  if (!current) {
    try {
      await JobLock.create({ name, lockedUntil: new Date(Date.now() + 30 * 60 * 1000), owner });
    } catch {
      return;
    }
  } else if (current.owner !== owner) {
    return;
  }
  try {
    await fn();
  } finally {
    await JobLock.updateOne({ name, owner }, { $set: { lockedUntil: new Date(0) } });
  }
}

async function processCompany(companyModules: Module[]) {
  const rules = await AlertRule.find({ enabled: true }).lean();
  const ruleMap = new Map(rules.map((rule) => [rule.type, rule]));
  const now = new Date();
  const hasFleet = companyModules.includes("fleet");
  const hasEquipment = companyModules.includes("equipment");
  const hasHr = companyModules.includes("hr");

  // 1. Process Fleet Module Alerts
  if (hasFleet) {
    // Istimara Expiries
    const istimaras = await Istimara.find().lean();
    const latestIstimara = new Map<string, (typeof istimaras)[number]>();
    for (const row of istimaras) {
      const key = String(row.vehicleId);
      const current = latestIstimara.get(key);
      if (!current || row.expiryDate > current.expiryDate) latestIstimara.set(key, row);
    }
    const rule = ruleMap.get("istimara_expiry");
    if (rule) {
      for (const row of latestIstimara.values()) {
        const vehicle = await Vehicle.findById(row.vehicleId).lean();
        if (!vehicle || vehicle.status === "sold" || vehicle.status === "inactive") continue;
        const days = daysBetween(now, row.expiryDate);
        const offset = matchingOffset(days, rule.offsets);
        if (offset == null) continue;
        const message = expiryMessage("Istimara", vehicle.plateNumber, row.expiryDate, days);
        const alert = await raiseAlert({
          type: "istimara_expiry",
          entityRef: String(row._id),
          vehicleId: String(vehicle._id),
          dueDate: row.expiryDate,
          offset,
          dedupeKey: `istimara_expiry:${row._id}:${offset}:${formatDisplayDate(row.expiryDate)}`,
          message,
        });
        if (alert) await sendAlertSms(String(alert._id), message, rule.recipients as Array<"admin" | "driver">);
      }
    }

    // Insurance Expiries
    const insuranceRule = ruleMap.get("insurance_expiry");
    if (insuranceRule) {
      const policies = await InsurancePolicy.find().lean();
      const latest = new Map<string, (typeof policies)[number]>();
      for (const row of policies) {
        const key = String(row.vehicleId);
        const current = latest.get(key);
        if (!current || row.endDate > current.endDate) latest.set(key, row);
      }
      for (const row of latest.values()) {
        const vehicle = await Vehicle.findById(row.vehicleId).lean();
        if (!vehicle || vehicle.status === "sold" || vehicle.status === "inactive") continue;
        const days = daysBetween(now, row.endDate);
        const offset = matchingOffset(days, insuranceRule.offsets);
        if (offset == null) continue;
        const message = expiryMessage("Insurance", vehicle.plateNumber, row.endDate, days);
        const alert = await raiseAlert({
          type: "insurance_expiry",
          entityRef: String(row._id),
          vehicleId: String(vehicle._id),
          dueDate: row.endDate,
          offset,
          dedupeKey: `insurance_expiry:${row._id}:${offset}:${formatDisplayDate(row.endDate)}`,
          message,
        });
        if (alert) await sendAlertSms(String(alert._id), message, insuranceRule.recipients as Array<"admin" | "driver">);
      }
    }

    // Maintenance Due (Date and Km)
    const dateRule = ruleMap.get("maintenance_date");
    const kmRule = ruleMap.get("maintenance_km");
    if (dateRule || kmRule) {
      const schedules = await MaintenanceSchedule.find().lean();
      for (const schedule of schedules) {
        const vehicle = await Vehicle.findById(schedule.vehicleId).lean();
        if (!vehicle || vehicle.status === "sold" || vehicle.status === "inactive") continue;
        const assignment = await Assignment.findOne({ vehicleId: vehicle._id, endDate: null }).lean();
        const driverId = assignment ? String(assignment.driverId) : undefined;
        if (dateRule && schedule.nextDueDate) {
          const days = daysBetween(now, schedule.nextDueDate);
          const offset = matchingOffset(days, dateRule.offsets);
          if (offset != null) {
            const message = maintenanceDateMessage(vehicle.plateNumber, schedule.serviceType, schedule.nextDueDate, days);
            const alert = await raiseAlert({
              type: "maintenance_date",
              entityRef: String(schedule._id),
              vehicleId: String(vehicle._id),
              driverId,
              dueDate: schedule.nextDueDate,
              offset,
              dedupeKey: `maintenance_date:${schedule._id}:${offset}:${formatDisplayDate(schedule.nextDueDate)}`,
              message,
            });
            if (alert) await sendAlertSms(String(alert._id), message, dateRule.recipients as Array<"admin" | "driver">, driverId);
          }
        }
        if (kmRule) {
          const remaining = schedule.nextDueKm - vehicle.odometerKm;
          const offset = matchingOffset(remaining, kmRule.offsets);
          if (offset != null) {
            const message = maintenanceKmMessage(vehicle.plateNumber, schedule.serviceType, remaining);
            const alert = await raiseAlert({
              type: "maintenance_km",
              entityRef: String(schedule._id),
              vehicleId: String(vehicle._id),
              driverId,
              offset,
              dedupeKey: `maintenance_km:${schedule._id}:${offset}:${schedule.nextDueKm}`,
              message,
            });
            if (alert) await sendAlertSms(String(alert._id), message, kmRule.recipients as Array<"admin" | "driver">, driverId);
          }
        }
      }
    }

    // Driver License and Iqama
    const licenseRule = ruleMap.get("license_expiry");
    const iqamaRule = ruleMap.get("iqama_expiry");
    if (licenseRule || iqamaRule) {
      const drivers = await Driver.find({ status: "active" }).lean();
      for (const driver of drivers) {
        if (licenseRule && driver.licenseExpiry) {
          const days = daysBetween(now, driver.licenseExpiry);
          const offset = matchingOffset(days, licenseRule.offsets);
          if (offset != null) {
            const message = expiryMessage("License", driver.name, driver.licenseExpiry, days);
            const alert = await raiseAlert({
              type: "license_expiry",
              entityRef: String(driver._id),
              driverId: String(driver._id),
              dueDate: driver.licenseExpiry,
              offset,
              dedupeKey: `license_expiry:${driver._id}:${offset}:${formatDisplayDate(driver.licenseExpiry)}`,
              message,
            });
            if (alert) await sendAlertSms(String(alert._id), message, licenseRule.recipients as Array<"admin" | "driver">, String(driver._id));
          }
        }
        if (iqamaRule && driver.iqamaExpiry) {
          const days = daysBetween(now, driver.iqamaExpiry);
          const offset = matchingOffset(days, iqamaRule.offsets);
          if (offset != null) {
            const message = expiryMessage("Iqama", driver.name, driver.iqamaExpiry, days);
            const alert = await raiseAlert({
              type: "iqama_expiry",
              entityRef: String(driver._id),
              driverId: String(driver._id),
              dueDate: driver.iqamaExpiry,
              offset,
              dedupeKey: `iqama_expiry:${driver._id}:${offset}:${formatDisplayDate(driver.iqamaExpiry)}`,
              message,
            });
            if (alert) await sendAlertSms(String(alert._id), message, iqamaRule.recipients as Array<"admin" | "driver">, String(driver._id));
          }
        }
      }
    }

    // EMI Installment Due
    const emiRule = ruleMap.get("emi_due");
    if (emiRule) {
      const installments = await EmiInstallment.find({ status: "unpaid" }).lean();
      for (const row of installments) {
        const days = daysBetween(now, row.dueDate);
        const offset = matchingOffset(days, emiRule.offsets);
        if (offset == null) continue;
        const vehicle = await Vehicle.findById(row.vehicleId).lean();
        if (!vehicle) continue;
        const message = emiMessage(vehicle.plateNumber, row.dueDate, row.amountHalalas, days);
        const alert = await raiseAlert({
          type: "emi_due",
          entityRef: String(row._id),
          vehicleId: String(vehicle._id),
          dueDate: row.dueDate,
          offset,
          dedupeKey: `emi_due:${row._id}:${offset}:${formatDisplayDate(row.dueDate)}`,
          message,
        });
        if (alert) await sendAlertSms(String(alert._id), message, emiRule.recipients as Array<"admin" | "driver">);
      }
    }
  }

  // 2. Process Generic Compliance Document Registry Expiries
  const complianceDocs = await ComplianceDocument.find({ isCurrent: true }).lean();
  for (const doc of complianceDocs) {
    const docDef: DocumentTypeDefinition | undefined = DOCUMENT_TYPE_REGISTRY[doc.docType];
    if (!docDef || !companyModules.includes(docDef.module)) continue;

    const days = daysBetween(now, doc.expiryDate);
    const offset = matchingOffset(days, docDef.defaultOffsets);
    if (offset == null) continue;

    const label = docDef.label || doc.docType;
    const message = `${label} #${doc.number} expires in ${days <= 0 ? "today" : `${days} days`}.`;

    const alert = await raiseAlert({
      type: "istimara_expiry", // fallback standard alert categorization
      entityRef: String(doc._id),
      dueDate: doc.expiryDate,
      offset,
      dedupeKey: `compliance_doc:${doc._id}:${offset}:${formatDisplayDate(doc.expiryDate)}`,
      message,
    });
    if (alert) {
      await sendAlertSms(String(alert._id), message, docDef.defaultRecipients);
    }
  }

  // 3. Process HR Module Contract Expiries
  if (hasHr) {
    const fixedContracts = await EmploymentContract.find({
      isCurrent: true,
      contractType: "fixed",
      endDate: { $ne: null },
    }).lean();
    for (const contract of fixedContracts) {
      if (!contract.endDate) continue;
      const emp = await Employee.findById(contract.employeeId).lean();
      if (!emp || emp.employmentStatus === "terminated") continue;
      const days = daysBetween(now, contract.endDate);
      const offset = matchingOffset(days, [60, 30, 7, 0]);
      if (offset == null) continue;
      const message = `Employment contract for ${emp.nameEn} (${emp.employeeNumber}) expires in ${days <= 0 ? "today" : `${days} days`}.`;
      const alert = await raiseAlert({
        type: "iqama_expiry",
        entityRef: String(contract._id),
        dueDate: contract.endDate,
        offset,
        dedupeKey: `hr_contract_expiry:${contract._id}:${offset}:${formatDisplayDate(contract.endDate)}`,
        message,
      });
      if (alert) await sendAlertSms(String(alert._id), message, ["admin"]);
    }
  }

  // 4. Process Equipment Module Inspections, Maintenance (Date/Km/Hours), and Mobilization
  if (hasEquipment) {
    const activeAssets = await Equipment.find({ status: { $nin: ["sold", "inactive"] } }).lean();
    const assetMap = new Map(activeAssets.map((a) => [String(a._id), a]));

    // Equipment Inspections Due
    const inspections = await EquipmentInspection.find({ nextDueDate: { $ne: null } }).sort({ inspectionDate: -1 }).lean();
    const latestInspectionByEquipment = new Map<string, (typeof inspections)[number]>();
    for (const insp of inspections) {
      const key = String(insp.equipmentId);
      if (!latestInspectionByEquipment.has(key)) latestInspectionByEquipment.set(key, insp);
    }
    for (const insp of latestInspectionByEquipment.values()) {
      if (!insp.nextDueDate) continue;
      const asset = assetMap.get(String(insp.equipmentId));
      if (!asset) continue;
      const days = daysBetween(now, insp.nextDueDate);
      const offset = matchingOffset(days, [30, 14, 7, 0]);
      if (offset == null) continue;
      const message = `Equipment inspection for ${asset.assetCode} (${asset.name}) is due in ${days <= 0 ? "today" : `${days} days`}.`;
      const alert = await raiseAlert({
        type: "maintenance_date",
        entityRef: String(insp._id),
        dueDate: insp.nextDueDate,
        offset,
        dedupeKey: `equipment_inspection_due:${insp._id}:${offset}:${formatDisplayDate(insp.nextDueDate)}`,
        message,
      });
      if (alert) await sendAlertSms(String(alert._id), message, ["admin"]);
    }

    // Equipment Maintenance Schedules (Date, Km, Hours)
    const eqSchedules = await MaintenanceSchedule.find({ "assetRef.kind": "equipment" }).lean();
    for (const schedule of eqSchedules) {
      const assetId = schedule.assetRef?.id ? String(schedule.assetRef.id) : "";
      const asset = assetMap.get(assetId);
      if (!asset) continue;

      if (schedule.nextDueDate) {
        const days = daysBetween(now, schedule.nextDueDate);
        const offset = matchingOffset(days, [14, 7, 0]);
        if (offset != null) {
          const message = `Equipment ${asset.assetCode} (${schedule.serviceType}) maintenance due on ${formatDisplayDate(schedule.nextDueDate)}.`;
          const alert = await raiseAlert({
            type: "maintenance_date",
            entityRef: String(schedule._id),
            dueDate: schedule.nextDueDate,
            offset,
            dedupeKey: `eq_maint_date:${schedule._id}:${offset}:${formatDisplayDate(schedule.nextDueDate)}`,
            message,
          });
          if (alert) await sendAlertSms(String(alert._id), message, ["admin"]);
        }
      }

      if (schedule.nextDueHours != null && schedule.nextDueHours > 0) {
        const remainingHours = schedule.nextDueHours - (asset.meterHours ?? 0);
        const offset = matchingOffset(remainingHours, [50, 10, 0]);
        if (offset != null) {
          const message = `Equipment ${asset.assetCode} (${schedule.serviceType}) due in ${remainingHours} operating hours.`;
          const alert = await raiseAlert({
            type: "maintenance_km",
            entityRef: String(schedule._id),
            offset,
            dedupeKey: `eq_maint_hours:${schedule._id}:${offset}:${schedule.nextDueHours}`,
            message,
          });
          if (alert) await sendAlertSms(String(alert._id), message, ["admin"]);
        }
      }
    }

    // Mobilizations Ending Soon
    const activeMobs = await EquipmentMobilization.find({
      status: "active",
      demobilizationDate: { $ne: null },
    }).lean();
    for (const mob of activeMobs) {
      if (!mob.demobilizationDate) continue;
      const asset = assetMap.get(String(mob.equipmentId));
      if (!asset) continue;
      const days = daysBetween(now, mob.demobilizationDate);
      const offset = matchingOffset(days, [14, 7, 1, 0]);
      if (offset == null) continue;
      const message = `Mobilization of ${asset.assetCode} at ${mob.clientName} (${mob.siteLocation}) ends in ${days <= 0 ? "today" : `${days} days`}.`;
      const alert = await raiseAlert({
        type: "maintenance_date",
        entityRef: String(mob._id),
        dueDate: mob.demobilizationDate,
        offset,
        dedupeKey: `eq_mob_end:${mob._id}:${offset}:${formatDisplayDate(mob.demobilizationDate)}`,
        message,
      });
      if (alert) await sendAlertSms(String(alert._id), message, ["admin"]);
    }
  }

  await retryFailedSms();
  void ALERT_TYPES;
}

export async function runDailyAlerts() {
  await withLock("daily-alerts", async () => {
    const companies = await requestContext.run({ skipTenant: true, internal: true }, () =>
      Company.find({ status: "active" }).lean(),
    );
    for (const company of companies) {
      const modules: Module[] = (company.modules && company.modules.length > 0 ? company.modules : ["fleet"]) as Module[];
      await requestContext.run(
        { companyId: String(company._id), skipTenant: false, internal: false },
        () => processCompany(modules),
      );
    }
    logger.info({ companies: companies.length }, "Daily alerts finished");
  });
}

export async function runSmsRetry() {
  await withLock("sms-retry", async () => {
    const companies = await requestContext.run({ skipTenant: true, internal: true }, () =>
      Company.find({ status: "active" }).lean(),
    );
    for (const company of companies) {
      await requestContext.run({ companyId: String(company._id), skipTenant: false, internal: false }, () => retryFailedSms());
    }
  });
}
