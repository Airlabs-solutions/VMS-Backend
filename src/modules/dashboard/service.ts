import { Types } from "mongoose";
import { daysBetween, riyadhDateKey } from "../../lib/dates";
import { requireCompanyId } from "../../lib/context";
import { hmacField } from "../../lib/crypto";
import { escapeRegex } from "../../lib/pagination";
import { dateDto, moneyDto, statusDto } from "../../lib/present";
import { expiryStatus, maintenanceStatus } from "../../lib/status";
import { Driver } from "../drivers/model";
import { EmiInstallment } from "../emi/model";
import { Expense } from "../operations/model";
import { FuelLog, Violation } from "../operations/model";
import { InsurancePolicy } from "../insurance/model";
import { Istimara } from "../istimara/model";
import { MaintenanceLog, MaintenanceSchedule } from "../maintenance/model";
import { Vehicle } from "../vehicles/model";

function monthStart(now = new Date()): Date {
  const key = riyadhDateKey(now);
  const [year, month] = key.split("-");
  return new Date(`${year}-${month}-01T00:00:00+03:00`);
}

function nextMonth(start: Date): Date {
  const key = riyadhDateKey(start);
  const [yearText, monthText] = key.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const nextYear = month === 12 ? year + 1 : year;
  const next = month === 12 ? 1 : month + 1;
  return new Date(`${nextYear}-${String(next).padStart(2, "0")}-01T00:00:00+03:00`);
}

export async function summary() {
  const start = monthStart();
  const end = nextMonth(start);
  const thisMonth = { $gte: start, $lt: end };
  const [total, active, inMaintenance, assigned, drivers, insurance, istimara, license, iqama] = await Promise.all([
    Vehicle.countDocuments(),
    Vehicle.countDocuments({ status: "active" }),
    Vehicle.countDocuments({ status: "in_maintenance" }),
    Vehicle.countDocuments({ currentDriverId: { $ne: null } }),
    Driver.countDocuments({ status: "active" }),
    InsurancePolicy.countDocuments({ endDate: thisMonth }),
    Istimara.countDocuments({ expiryDate: thisMonth }),
    Driver.countDocuments({ status: "active", licenseExpiry: thisMonth }),
    Driver.countDocuments({ status: "active", iqamaExpiry: thisMonth }),
  ]);
  return {
    totalVehicles: total,
    active,
    inMaintenance,
    assigned,
    unassigned: total - assigned,
    drivers,
    monthlyExpiries: {
      insurance,
      istimara,
      license,
      iqama,
      total: insurance + istimara + license + iqama,
    },
  };
}

export async function attention() {
  const now = new Date();
  const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const vehicles = await Vehicle.find({ status: { $in: ["active", "in_maintenance"] } }).select("plateNumber odometerKm").lean();
  const plates = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));
  const items: Array<{ kind: string; title: string; dueDate: string | null; status: { code: string; label: string }; vehicleId: string }> = [];

  const istimaras = await Istimara.find({ expiryDate: { $lte: horizon } }).lean();
  for (const row of istimaras) {
    const vehicle = plates.get(String(row.vehicleId));
    if (!vehicle) continue;
    const status = expiryStatus(row.expiryDate, now);
    items.push({
      kind: "Istimara",
      title: `${vehicle.plateNumber} istimara`,
      dueDate: dateDto(row.expiryDate),
      status: statusDto(status === "valid" ? "expiring_soon" : status),
      vehicleId: String(row.vehicleId),
    });
  }
  const policies = await InsurancePolicy.find({ endDate: { $lte: horizon } }).lean();
  for (const row of policies) {
    const vehicle = plates.get(String(row.vehicleId));
    if (!vehicle) continue;
    items.push({
      kind: "Insurance",
      title: `${vehicle.plateNumber} insurance`,
      dueDate: dateDto(row.endDate),
      status: statusDto(expiryStatus(row.endDate, now)),
      vehicleId: String(row.vehicleId),
    });
  }
  const schedules = await MaintenanceSchedule.find().lean();
  for (const row of schedules) {
    const vehicle = plates.get(String(row.vehicleId));
    if (!vehicle) continue;
    const status = maintenanceStatus({ nextDueDate: row.nextDueDate, nextDueKm: row.nextDueKm, odometerKm: vehicle.odometerKm, now });
    const soon = row.nextDueDate && row.nextDueDate <= horizon;
    if (status === "ok" && !soon) continue;
    if (status === "ok") continue;
    items.push({
      kind: "Maintenance",
      title: `${vehicle.plateNumber} ${row.serviceType}`,
      dueDate: dateDto(row.nextDueDate),
      status: statusDto(status),
      vehicleId: String(row.vehicleId),
    });
  }
  const drivers = await Driver.find({ status: "active", $or: [{ licenseExpiry: { $lte: horizon } }, { iqamaExpiry: { $lte: horizon } }] }).lean();
  for (const driver of drivers) {
    if (daysBetween(now, driver.licenseExpiry) <= 30) {
      items.push({
        kind: "License",
        title: `${driver.name} license`,
        dueDate: dateDto(driver.licenseExpiry),
        status: statusDto(expiryStatus(driver.licenseExpiry, now)),
        vehicleId: "",
      });
    }
    if (daysBetween(now, driver.iqamaExpiry) <= 30) {
      items.push({
        kind: "Iqama",
        title: `${driver.name} iqama`,
        dueDate: dateDto(driver.iqamaExpiry),
        status: statusDto(expiryStatus(driver.iqamaExpiry, now)),
        vehicleId: "",
      });
    }
  }
  return items.slice(0, 50);
}

async function sumField(model: object, match: Record<string, unknown>, field: string) {
  const rows = await (model as { aggregate: (pipeline: object[]) => PromiseLike<Array<{ total?: number }>> }).aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: `$${field}` } } },
  ]);
  return rows[0]?.total ?? 0;
}

export async function costs(from = monthStart(), to = new Date()) {
  const range = { $gte: from, $lte: to };
  const [maintenance, fuel, fines, other, emi, insurance] = await Promise.all([
    sumField(MaintenanceLog, { date: range }, "costHalalas"),
    sumField(FuelLog, { date: range, approvalStatus: "approved" }, "costHalalas"),
    Violation.aggregate([{ $match: { date: range } }, { $group: { _id: null, total: { $sum: "$amountHalalas" } } }]).then((rows) => rows[0]?.total ?? 0),
    sumField(Expense, { date: range }, "amountHalalas"),
    EmiInstallment.aggregate([
      { $match: { status: "paid", paidDate: range } },
      { $group: { _id: null, total: { $sum: "$amountHalalas" } } },
    ]).then((rows) => rows[0]?.total ?? 0),
    InsurancePolicy.aggregate([
      { $match: { startDate: range } },
      { $group: { _id: null, total: { $sum: "$premiumHalalas" } } },
    ]).then((rows) => rows[0]?.total ?? 0),
  ]);
  const categories = { maintenance, fuel, emi, insurance, fines, other };
  const total = Object.values(categories).reduce((sum, value) => sum + value, 0);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    total: moneyDto(total),
    categories: Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, moneyDto(value)])),
  };
}

export async function unpaid() {
  const [emis, violations] = await Promise.all([
    EmiInstallment.find({ status: "unpaid", dueDate: { $lte: new Date() } }).sort({ dueDate: 1 }).limit(20).lean(),
    Violation.find({ status: "unpaid" }).sort({ date: -1 }).limit(20).lean(),
  ]);
  return {
    emis: emis.map((row) => ({
      id: String(row._id),
      vehicleId: String(row.vehicleId),
      dueDate: dateDto(row.dueDate),
      amount: moneyDto(row.amountHalalas),
    })),
    violations: violations.map((row) => ({
      id: String(row._id),
      vehicleId: String(row.vehicleId),
      date: dateDto(row.date),
      amount: moneyDto(row.amountHalalas),
      number: row.number,
    })),
  };
}

export async function search(q: string) {
  const term = q.trim();
  if (!term) return { vehicles: [], drivers: [] };
  const vehicles = await Vehicle.find({ plateNumber: new RegExp(escapeRegex(term), "i") }).limit(8).lean();
  const driverFilter: Record<string, unknown> = /^\d{10}$/.test(term)
    ? { iqamaHash: hmacField(term) }
    : { name: new RegExp(escapeRegex(term), "i") };
  const drivers = await Driver.find(driverFilter).limit(8).lean();
  return {
    vehicles: vehicles.map((vehicle) => ({ id: String(vehicle._id), plateNumber: vehicle.plateNumber, make: vehicle.make, model: vehicle.modelName })),
    drivers: drivers.map((driver) => ({ id: String(driver._id), name: driver.name, mobileMasked: `***** ${driver.mobileLast4}` })),
  };
}

export function currentCompanyId() {
  return requireCompanyId();
}

void Types;
