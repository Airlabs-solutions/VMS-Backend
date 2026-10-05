import type { Response } from "express";
import { Types } from "mongoose";
import { formatDisplayDate } from "../../lib/dates";
import { formatSar } from "../../lib/money";
import { listArgs, listResult, writeXlsx } from "../../lib/pagination";
import { dateDto, moneyDto, statusDto } from "../../lib/present";
import { expiryStatus, maintenanceStatus } from "../../lib/status";
import { Assignment, Driver } from "../drivers/model";
import { EmiInstallment, EmiPlan } from "../emi/model";
import { Expense, FuelLog, Trip, Violation } from "../operations/model";
import { InsurancePolicy } from "../insurance/model";
import { Istimara } from "../istimara/model";
import { MaintenanceLog, MaintenanceSchedule } from "../maintenance/model";
import { Vehicle } from "../vehicles/model";

export type ReportQuery = {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  vehicleId?: string;
  driverId?: string;
};

function range(query: ReportQuery) {
  const filter: Record<string, unknown> = {};
  if (query.from || query.to) {
    const date: Record<string, Date> = {};
    if (query.from) date.$gte = new Date(query.from);
    if (query.to) date.$lte = new Date(query.to);
    filter.date = date;
  }
  if (query.vehicleId) filter.vehicleId = new Types.ObjectId(query.vehicleId);
  if (query.driverId) filter.driverId = new Types.ObjectId(query.driverId);
  return filter;
}

async function nameMaps() {
  const [vehicles, drivers] = await Promise.all([
    Vehicle.find().select("plateNumber make modelName odometerKm currentDriverId status").lean(),
    Driver.find().select("name licenseExpiry iqamaExpiry").lean(),
  ]);
  return {
    vehicles,
    plates: new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.plateNumber])),
    drivers: new Map(drivers.map((driver) => [String(driver._id), driver.name])),
    driverDocs: new Map(drivers.map((driver) => [String(driver._id), driver])),
  };
}

export async function runReport(name: string, raw: ReportQuery, res?: Response) {
  const query = listArgs({ page: raw.page, limit: raw.limit }, ["createdAt"], "-createdAt");
  const maps = await nameMaps();
  let rows: Record<string, unknown>[] = [];

  if (name === "vehicles") {
    const filter: Record<string, unknown> = {};
    if (raw.vehicleId) filter._id = raw.vehicleId;
    const list = maps.vehicles.filter((vehicle) => !raw.vehicleId || String(vehicle._id) === raw.vehicleId);
    rows = list.map((vehicle) => ({
      plateNumber: vehicle.plateNumber,
      make: vehicle.make,
      model: vehicle.modelName,
      odometerKm: vehicle.odometerKm,
      status: statusDto(vehicle.status).label,
      driver: vehicle.currentDriverId ? maps.drivers.get(String(vehicle.currentDriverId)) ?? "" : "",
    }));
  } else if (name === "expiries") {
    const istimaras = await Istimara.find(raw.vehicleId ? { vehicleId: raw.vehicleId } : {}).lean();
    const policies = await InsurancePolicy.find(raw.vehicleId ? { vehicleId: raw.vehicleId } : {}).lean();
    rows = [
      ...istimaras.map((row) => ({
        kind: "Istimara",
        plateNumber: maps.plates.get(String(row.vehicleId)) ?? "",
        reference: row.number,
        expiry: formatDisplayDate(row.expiryDate),
        status: statusDto(expiryStatus(row.expiryDate)).label,
      })),
      ...policies.map((row) => ({
        kind: "Insurance",
        plateNumber: maps.plates.get(String(row.vehicleId)) ?? "",
        reference: row.policyNumber,
        expiry: formatDisplayDate(row.endDate),
        status: statusDto(expiryStatus(row.endDate)).label,
      })),
      ...[...maps.driverDocs.values()].map((driver) => ({
        kind: "License",
        plateNumber: "",
        reference: driver.name,
        expiry: formatDisplayDate(driver.licenseExpiry),
        status: statusDto(expiryStatus(driver.licenseExpiry)).label,
      })),
      ...[...maps.driverDocs.values()].map((driver) => ({
        kind: "Iqama",
        plateNumber: "",
        reference: driver.name,
        expiry: formatDisplayDate(driver.iqamaExpiry),
        status: statusDto(expiryStatus(driver.iqamaExpiry)).label,
      })),
    ];
  } else if (name === "maintenance") {
    const logs = await MaintenanceLog.find(range(raw)).sort({ date: -1 }).limit(5000).lean();
    const schedules = await MaintenanceSchedule.find(raw.vehicleId ? { vehicleId: raw.vehicleId } : {}).lean();
    const next = new Map(schedules.map((schedule) => [String(schedule.vehicleId) + schedule.serviceType, schedule]));
    rows = logs.map((row) => {
      const schedule = next.get(String(row.vehicleId) + row.serviceType);
      const vehicle = maps.vehicles.find((item) => String(item._id) === String(row.vehicleId));
      return {
        date: formatDisplayDate(row.date),
        plateNumber: maps.plates.get(String(row.vehicleId)) ?? "",
        serviceType: row.serviceType,
        cost: formatSar(row.costHalalas),
        odometerKm: row.odometerKm,
        nextDue: schedule ? formatDisplayDate(schedule.nextDueDate) : "",
        status: schedule
          ? statusDto(maintenanceStatus({ nextDueDate: schedule.nextDueDate, nextDueKm: schedule.nextDueKm, odometerKm: vehicle?.odometerKm ?? 0 })).label
          : "",
      };
    });
  } else if (name === "costs") {
    const filter = range(raw);
    const [maintenance, fuel, emis, policies, fines, expenses] = await Promise.all([
      MaintenanceLog.find(filter).lean(),
      FuelLog.find({ ...filter, approvalStatus: "approved" }).lean(),
      EmiInstallment.find({ status: "paid", ...(raw.vehicleId ? { vehicleId: raw.vehicleId } : {}), ...(filter.date ? { paidDate: filter.date } : {}) }).lean(),
      InsurancePolicy.find(raw.vehicleId ? { vehicleId: raw.vehicleId } : {}).lean(),
      Violation.find(filter).lean(),
      Expense.find(filter).lean(),
    ]);
    const ids = new Set<string>(maps.vehicles.map((vehicle) => String(vehicle._id)));
    rows = [...ids].map((id) => {
      const maintenanceTotal = maintenance.filter((row) => String(row.vehicleId) === id).reduce((sum, row) => sum + row.costHalalas, 0);
      const fuelTotal = fuel.filter((row) => String(row.vehicleId) === id).reduce((sum, row) => sum + row.costHalalas, 0);
      const emiTotal = emis.filter((row) => String(row.vehicleId) === id).reduce((sum, row) => sum + row.amountHalalas, 0);
      const insuranceTotal = policies.filter((row) => String(row.vehicleId) === id).reduce((sum, row) => sum + row.premiumHalalas, 0);
      const finesTotal = fines.filter((row) => String(row.vehicleId) === id).reduce((sum, row) => sum + row.amountHalalas, 0);
      const otherTotal = expenses.filter((row) => String(row.vehicleId) === id).reduce((sum, row) => sum + row.amountHalalas, 0);
      const total = maintenanceTotal + fuelTotal + emiTotal + insuranceTotal + finesTotal + otherTotal;
      return {
        plateNumber: maps.plates.get(id) ?? "",
        maintenance: formatSar(maintenanceTotal),
        fuel: formatSar(fuelTotal),
        emi: formatSar(emiTotal),
        insurance: formatSar(insuranceTotal),
        fines: formatSar(finesTotal),
        other: formatSar(otherTotal),
        total: formatSar(total),
        totalHalalas: total,
      };
    }).filter((row) => row.totalHalalas > 0 || !raw.from);
  } else if (name === "fuel") {
    const logs = await FuelLog.find({ ...range(raw), approvalStatus: "approved" }).lean();
    const grouped = new Map<string, { liters: number; cost: number; minKm: number; maxKm: number }>();
    for (const row of logs) {
      const key = String(row.vehicleId);
      const current = grouped.get(key) ?? { liters: 0, cost: 0, minKm: row.odometerKm, maxKm: row.odometerKm };
      current.liters += row.liters;
      current.cost += row.costHalalas;
      current.minKm = Math.min(current.minKm, row.odometerKm);
      current.maxKm = Math.max(current.maxKm, row.odometerKm);
      grouped.set(key, current);
    }
    rows = [...grouped.entries()].map(([id, value]) => ({
      plateNumber: maps.plates.get(id) ?? "",
      liters: Number(value.liters.toFixed(2)),
      cost: formatSar(value.cost),
      kmPerLiter: value.liters > 0 ? Number(((value.maxKm - value.minKm) / value.liters).toFixed(2)) : 0,
    }));
  } else if (name === "emi") {
    const plans = await EmiPlan.find(raw.vehicleId ? { vehicleId: raw.vehicleId } : {}).lean();
    for (const plan of plans) {
      const installments = await EmiInstallment.find({ emiPlanId: plan._id }).lean();
      const paid = installments.filter((item) => item.status === "paid").reduce((sum, item) => sum + item.amountHalalas, 0);
      const remaining = installments.filter((item) => item.status === "unpaid").reduce((sum, item) => sum + item.amountHalalas, 0);
      const upcoming = installments.find((item) => item.status === "unpaid");
      rows.push({
        plateNumber: maps.plates.get(String(plan.vehicleId)) ?? "",
        bank: plan.bank,
        paid: formatSar(paid),
        remaining: formatSar(remaining),
        upcoming: upcoming ? formatDisplayDate(upcoming.dueDate) : "",
        monthly: formatSar(plan.monthlyAmountHalalas),
      });
    }
  } else if (name === "violations") {
    const list = await Violation.find(range(raw)).sort({ date: -1 }).limit(5000).lean();
    rows = list.map((row) => ({
      date: formatDisplayDate(row.date),
      plateNumber: maps.plates.get(String(row.vehicleId)) ?? "",
      driver: row.driverId ? maps.drivers.get(String(row.driverId)) ?? "" : "",
      number: row.number,
      type: row.type,
      amount: formatSar(row.amountHalalas),
      status: statusDto(row.status).label,
    }));
  } else if (name === "assignments") {
    const filter: Record<string, unknown> = {};
    if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
    if (raw.driverId) filter.driverId = raw.driverId;
    const list = await Assignment.find(filter).sort({ startDate: -1 }).limit(5000).lean();
    rows = list.map((row) => ({
      plateNumber: maps.plates.get(String(row.vehicleId)) ?? "",
      driver: maps.drivers.get(String(row.driverId)) ?? "",
      startDate: formatDisplayDate(row.startDate),
      endDate: formatDisplayDate(row.endDate),
    }));
  } else {
    rows = [];
  }

  if (res) {
    const columns = Object.keys(rows[0] ?? { message: "No rows" }).filter((key) => key !== "totalHalalas").map((key) => ({ header: key, key }));
    const exportRows = rows.map((row) => {
      const copy = { ...row };
      delete copy.totalHalalas;
      return copy;
    });
    await writeXlsx(res, `${name}.xlsx`, columns, exportRows);
    return;
  }

  const total = rows.length;
  const pageRows = rows.slice(query.skip, query.skip + query.limit);
  return listResult(pageRows, total, query);
}

void dateDto;
void moneyDto;
void Trip;
