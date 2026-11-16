import ExcelJS from "exceljs";
import { Types } from "mongoose";
import { z } from "zod";
import { EXPENSE_CATEGORIES } from "../../config/constants";
import { Client, Project } from "../../core/clients/model";
import { ComplianceDocument } from "../../core/documents/model";
import { getDocumentTypeDefinition } from "../../core/documents/registry";
import { Employee } from "../../core/employees/model";
import { assertWithinLimit } from "../../core/tenant/limits";
import { requireCompanyId } from "../../lib/context";
import { addDays, addMonths, daysBetween, formatRiyadhDate, parseDateInput } from "../../lib/dates";
import { AppError, notFound } from "../../lib/errors";
import { halalasToSar, sarToHalalas } from "../../lib/money";
import { pageResult, parsePagination } from "../../lib/pagination";
import { dateDto, moneyDto, statusDto } from "../../lib/present";
import { expiryStatus, maintenanceStatus } from "../../lib/status";
import { isDuplicateKey } from "../../lib/tenantPlugin";
import { dateString, moneyInput, objectIdString } from "../../lib/zod";
import { Company } from "../companies/model";
import { MaintenanceLog, MaintenanceSchedule } from "../maintenance/model";
import { Expense } from "../operations/model";
import {
  Equipment,
  EquipmentCategory,
  EquipmentInspection,
  EquipmentMobilization,
  EquipmentOperatorAssignment,
} from "./model";

const DEFAULT_CATEGORIES = [
  { name: "Crane", meterType: "both" as const },
  { name: "Excavator", meterType: "hours" as const },
  { name: "Wheel Loader", meterType: "hours" as const },
  { name: "Forklift", meterType: "hours" as const },
  { name: "Generator", meterType: "hours" as const },
  { name: "Air Compressor", meterType: "hours" as const },
];

export const categoryBody = z.object({
  name: z.string().trim().min(2).max(80),
  meterType: z.enum(["hours", "km", "both"]).default("hours"),
  requiredDocTypes: z.array(z.string()).optional(),
  defaultChecklist: z
    .array(
      z.object({
        label: z.string().trim().min(2).max(200),
        critical: z.boolean().default(false),
      }),
    )
    .optional(),
});

export const equipmentCreateBody = z.object({
  assetCode: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(120),
  categoryName: z.string().trim().min(2).max(80),
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  serialNumber: z.string().trim().min(1).max(80),
  year: z.coerce.number().int().min(1980).max(2100),
  capacity: z.string().trim().max(60).default(""),
  ownership: z.enum(["owned", "rented_in", "rented_out"]).default("owned"),
  supplierOrLessor: z.string().trim().max(120).default(""),
  purchaseOrRentalCostSar: moneyInput.default(0),
  status: z.enum(["available", "mobilized", "in_maintenance", "inactive", "sold"]).default("available"),
  meterHours: z.coerce.number().min(0).default(0),
  odometerKm: z.coerce.number().min(0).default(0),
  currentLocation: z.string().trim().max(120).default("Main Yard"),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

export const equipmentUpdateBody = equipmentCreateBody.partial();

export const equipmentDocBody = z.object({
  docType: z.enum([
    "tuv_card",
    "inspection_certificate",
    "calibration_certificate",
    "operating_permit",
    "equipment_istimara",
    "equipment_insurance",
  ]),
  number: z.string().trim().min(1).max(80),
  issueDate: dateString.optional().or(z.literal("")),
  expiryDate: dateString,
  fileIds: z.array(objectIdString).optional().default([]),
});

export const inspectionBody = z.object({
  inspectorName: z.string().trim().min(2).max(100),
  inspectionDate: dateString,
  nextDueDate: dateString.optional().or(z.literal("")),
  meterHours: z.coerce.number().min(0).default(0),
  odometerKm: z.coerce.number().min(0).default(0),
  items: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200),
        critical: z.boolean().default(false),
        result: z.enum(["pass", "fail", "na"]),
        notes: z.string().trim().max(300).default(""),
      }),
    )
    .min(1),
  signatureText: z.string().trim().max(100).default(""),
  notes: z.string().trim().max(1000).default(""),
});

export const equipmentMaintenanceScheduleBody = z.object({
  serviceType: z.string().trim().min(2).max(100),
  intervalMonths: z.coerce.number().int().min(1).max(60).default(3),
  intervalHours: z.coerce.number().min(0).default(250),
  intervalKm: z.coerce.number().min(0).default(0),
  nextDueDate: dateString,
  nextDueHours: z.coerce.number().min(0).optional(),
  nextDueKm: z.coerce.number().min(0).optional(),
});

export const equipmentMaintenanceLogBody = z.object({
  serviceType: z.string().trim().min(2).max(100),
  date: dateString,
  meterHours: z.coerce.number().min(0).default(0),
  odometerKm: z.coerce.number().min(0).default(0),
  workshop: z.string().trim().max(120).default(""),
  costSar: moneyInput,
  notes: z.string().trim().max(1000).default(""),
});

export const mobilizationBody = z.object({
  clientName: z.string().trim().min(2).max(120),
  projectName: z.string().trim().max(120).default(""),
  siteLocation: z.string().trim().min(2).max(120),
  mobilizationDate: dateString,
  demobilizationDate: dateString.optional().or(z.literal("")),
  rateType: z.enum(["hourly", "daily", "monthly"]).default("daily"),
  rateSar: moneyInput,
  operatorName: z.string().trim().max(100).default(""),
  operatorEmployeeId: objectIdString.optional().or(z.literal("")),
  status: z.enum(["planned", "active", "completed"]).default("active"),
  notes: z.string().trim().max(1000).default(""),
});

export const operatorAssignmentBody = z.object({
  employeeId: objectIdString.optional().or(z.literal("")),
  operatorName: z.string().trim().min(2).max(120),
  operatorMobile: z.string().trim().max(30).default(""),
  licenseOrCertNumber: z.string().trim().max(80).default(""),
  startDate: dateString,
  endDate: dateString.optional().or(z.literal("")),
  notes: z.string().trim().max(500).default(""),
});

export const equipmentExpenseBody = z.object({
  category: z.enum(EXPENSE_CATEGORIES).default("other"),
  amountSar: moneyInput,
  date: dateString,
  notes: z.string().trim().max(1000).default(""),
});

export const clientProjectBody = z.object({
  clientName: z.string().trim().min(2).max(120),
  clientCode: z.string().trim().min(2).max(30),
  city: z.string().trim().max(60).default("Riyadh"),
  contactPerson: z.string().trim().max(80).default(""),
  mobile: z.string().trim().max(30).default(""),
  projectName: z.string().trim().max(120).optional().default(""),
  projectCode: z.string().trim().max(30).optional().default(""),
  siteLocation: z.string().trim().max(120).optional().default(""),
});

function toEquipmentDto(row: any) {
  return {
    id: String(row._id),
    assetCode: row.assetCode,
    name: row.name,
    categoryName: row.categoryName,
    make: row.make,
    model: row.model,
    serialNumber: row.serialNumber,
    year: row.year,
    capacity: row.capacity ?? "",
    ownership: statusDto(row.ownership ?? "owned"),
    supplierOrLessor: row.supplierOrLessor ?? "",
    purchaseOrRentalCost: moneyDto(row.purchaseOrRentalCostHalalas ?? 0),
    status: statusDto(row.status ?? "available"),
    meterHours: row.meterHours ?? 0,
    odometerKm: row.odometerKm ?? 0,
    currentLocation: row.currentLocation ?? "Main Yard",
    customFields: row.customFields instanceof Map ? Object.fromEntries(row.customFields) : (row.customFields ?? {}),
  };
}

export async function listEquipmentCategories() {
  let rows = await EquipmentCategory.find().sort({ name: 1 }).lean();
  if (rows.length === 0) {
    for (const def of DEFAULT_CATEGORIES) {
      await EquipmentCategory.create(def).catch(() => {});
    }
    rows = await EquipmentCategory.find().sort({ name: 1 }).lean();
  }
  return rows.map((r) => ({
    id: String(r._id),
    name: r.name,
    meterType: r.meterType,
    requiredDocTypes: r.requiredDocTypes ?? [],
    defaultChecklist: r.defaultChecklist ?? [],
  }));
}

export async function createEquipmentCategory(input: z.infer<typeof categoryBody>) {
  try {
    const created = await EquipmentCategory.create({
      name: input.name.trim(),
      meterType: input.meterType,
      requiredDocTypes: input.requiredDocTypes ?? ["tuv_card", "inspection_certificate", "equipment_insurance"],
      defaultChecklist: input.defaultChecklist,
    });
    return {
      id: String(created._id),
      name: created.name,
      meterType: created.meterType,
      defaultChecklist: created.defaultChecklist,
    };
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "DUPLICATE_CATEGORY", "This equipment category already exists");
    }
    throw error;
  }
}

export async function getEquipmentDashboard() {
  const now = new Date();
  const [assets, docs, inspections, mobilizations, maintLogs, expenses] = await Promise.all([
    Equipment.find().lean(),
    ComplianceDocument.find({ "ownerRef.kind": "equipment", isCurrent: true }).lean(),
    EquipmentInspection.find().sort({ inspectionDate: -1 }).lean(),
    EquipmentMobilization.find({ status: { $in: ["active", "planned"] } }).sort({ mobilizationDate: -1 }).lean(),
    MaintenanceLog.find({ "assetRef.kind": "equipment" }).lean(),
    Expense.find({ "assetRef.kind": "equipment" }).lean(),
  ]);

  const activeAssets = assets.filter((a) => a.status !== "sold" && a.status !== "inactive");
  const mobilizedCount = assets.filter((a) => a.status === "mobilized").length;
  const availableCount = assets.filter((a) => a.status === "available").length;
  const inMaintCount = assets.filter((a) => a.status === "in_maintenance").length;

  const utilizationPercent =
    activeAssets.length > 0 ? Math.round((mobilizedCount / activeAssets.length) * 100) : 0;

  //Latest inspection per equipment
  const latestInspByEquip = new Map<string, any>();
  for (const insp of inspections) {
    const k = String(insp.equipmentId);
    if (!latestInspByEquip.has(k)) latestInspByEquip.set(k, insp);
  }

  let inspectionsDue = 0;
  let inspectionsOverdue = 0;
  for (const asset of activeAssets) {
    const latest = latestInspByEquip.get(String(asset._id));
    if (!latest) {
      inspectionsDue += 1;
    } else if (latest.nextDueDate < now || latest.overallResult === "fail") {
      inspectionsOverdue += 1;
    } else if (daysBetween(now, latest.nextDueDate) <= 7) {
      inspectionsDue += 1;
    }
  }

  let docsExpiringSoon = 0;
  let docsExpired = 0;
  for (const d of docs) {
    const st = expiryStatus(d.expiryDate, now);
    if (st === "expired") docsExpired += 1;
    else if (st === "expiring_soon") docsExpiringSoon += 1;
  }

  // Cost per equipment calculation
  const maintCostByEquip = new Map<string, number>();
  for (const m of maintLogs) {
    const id = m.assetRef?.id ? String(m.assetRef.id) : "";
    if (id) maintCostByEquip.set(id, (maintCostByEquip.get(id) ?? 0) + (m.costHalalas ?? 0));
  }
  const expCostByEquip = new Map<string, number>();
  for (const ex of expenses) {
    const id = ex.assetRef?.id ? String(ex.assetRef.id) : "";
    if (id) expCostByEquip.set(id, (expCostByEquip.get(id) ?? 0) + (ex.amountHalalas ?? 0));
  }

  const costPerEquipment = assets.slice(0, 15).map((a) => {
    const id = String(a._id);
    const maint = maintCostByEquip.get(id) ?? 0;
    const exp = expCostByEquip.get(id) ?? 0;
    const base = a.purchaseOrRentalCostHalalas ?? 0;
    return {
      id,
      assetCode: a.assetCode,
      name: a.name,
      categoryName: a.categoryName,
      status: statusDto(a.status),
      maintenanceCost: moneyDto(maint),
      expenseCost: moneyDto(exp),
      totalOperatingCost: moneyDto(maint + exp),
      acquisitionOrRentalCost: moneyDto(base),
    };
  });

  return {
    summary: {
      totalAssets: assets.length,
      available: availableCount,
      mobilized: mobilizedCount,
      inMaintenance: inMaintCount,
      utilizationPercent,
      inspectionsDue,
      inspectionsOverdue,
      docsExpiringSoon,
      docsExpired,
    },
    idleEquipment: assets
      .filter((a) => a.status === "available")
      .slice(0, 10)
      .map(toEquipmentDto),
    activeMobilizations: mobilizations.slice(0, 10).map((m) => ({
      id: String(m._id),
      equipmentId: String(m.equipmentId),
      clientName: m.clientName,
      projectName: m.projectName ?? "",
      siteLocation: m.siteLocation,
      mobilizationDate: dateDto(m.mobilizationDate),
      demobilizationDate: dateDto(m.demobilizationDate),
      rateType: m.rateType,
      rate: moneyDto(m.rateHalalas),
      status: statusDto(m.status),
    })),
    costPerEquipment,
  };
}

export async function listEquipmentAssets(query: Record<string, unknown>) {
  const { page, pageSize, skip } = parsePagination(query);
  const filter: Record<string, unknown> = {};

  if (typeof query.category === "string" && query.category.trim()) {
    filter.categoryName = query.category.trim();
  }
  if (typeof query.status === "string" && query.status.trim()) {
    filter.status = query.status.trim();
  }
  if (typeof query.location === "string" && query.location.trim()) {
    filter.currentLocation = new RegExp(query.location.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  if (typeof query.q === "string" && query.q.trim()) {
    const q = query.q.trim();
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ assetCode: rx }, { name: rx }, { make: rx }, { model: rx }, { serialNumber: rx }, { currentLocation: rx }];
  }

  const [rows, total] = await Promise.all([
    Equipment.find(filter).sort({ assetCode: 1 }).skip(skip).limit(pageSize).lean(),
    Equipment.countDocuments(filter),
  ]);

  return pageResult(rows.map(toEquipmentDto), total, page, pageSize);
}

export async function createEquipmentAsset(input: z.infer<typeof equipmentCreateBody>) {
  const companyId = requireCompanyId();
  await assertWithinLimit(companyId, "equipment");

  const cat = await EquipmentCategory.findOne({ name: input.categoryName.trim() }).lean();

  try {
    const created = await Equipment.create({
      assetCode: input.assetCode.trim().toUpperCase(),
      name: input.name.trim(),
      categoryId: cat?._id,
      categoryName: input.categoryName.trim(),
      make: input.make.trim(),
      model: input.model.trim(),
      serialNumber: input.serialNumber.trim(),
      year: input.year,
      capacity: input.capacity.trim(),
      ownership: input.ownership,
      supplierOrLessor: input.supplierOrLessor.trim(),
      purchaseOrRentalCostHalalas: sarToHalalas(input.purchaseOrRentalCostSar),
      status: input.status,
      meterHours: input.meterHours,
      odometerKm: input.odometerKm,
      currentLocation: input.currentLocation.trim() || "Main Yard",
      customFields: input.customFields ?? {},
    });

    await MaintenanceSchedule.create({
      assetRef: { kind: "equipment", id: created._id },
      serviceType: cat?.defaultMaintenance?.serviceType ?? "250-Hour Preventive Service",
      intervalMonths: cat?.defaultMaintenance?.intervalMonths ?? 3,
      intervalHours: cat?.defaultMaintenance?.intervalHours ?? 250,
      intervalKm: cat?.defaultMaintenance?.intervalKm ?? 5000,
      nextDueDate: addMonths(new Date(), cat?.defaultMaintenance?.intervalMonths ?? 3),
      nextDueHours: (input.meterHours || 0) + (cat?.defaultMaintenance?.intervalHours ?? 250),
      nextDueKm: (input.odometerKm || 0) + (cat?.defaultMaintenance?.intervalKm ?? 5000),
    });

    return toEquipmentDto(created.toObject());
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "DUPLICATE_ASSET_CODE", "An equipment asset with this asset code already exists");
    }
    throw error;
  }
}

export async function updateEquipmentAsset(id: string, input: z.infer<typeof equipmentUpdateBody>) {
  const asset = await Equipment.findById(id);
  if (!asset) throw notFound("Equipment");

  if (input.assetCode !== undefined) asset.assetCode = input.assetCode.trim().toUpperCase();
  if (input.name !== undefined) asset.name = input.name.trim();
  if (input.categoryName !== undefined) asset.categoryName = input.categoryName.trim();
  if (input.make !== undefined) asset.make = input.make.trim();
  if (input.model !== undefined) asset.set("model", input.model.trim());
  if (input.serialNumber !== undefined) asset.serialNumber = input.serialNumber.trim();
  if (input.year !== undefined) asset.year = input.year;
  if (input.capacity !== undefined) asset.capacity = input.capacity.trim();
  if (input.ownership !== undefined) asset.ownership = input.ownership;
  if (input.supplierOrLessor !== undefined) asset.supplierOrLessor = input.supplierOrLessor.trim();
  if (input.purchaseOrRentalCostSar !== undefined) {
    asset.purchaseOrRentalCostHalalas = sarToHalalas(input.purchaseOrRentalCostSar);
  }
  if (input.status !== undefined) asset.status = input.status;
  if (input.meterHours !== undefined) asset.meterHours = input.meterHours;
  if (input.odometerKm !== undefined) asset.odometerKm = input.odometerKm;
  if (input.currentLocation !== undefined) asset.currentLocation = input.currentLocation.trim();
  if (input.customFields !== undefined) {
    asset.customFields = new Map(Object.entries(input.customFields));
  }

  await asset.save();
  return toEquipmentDto(asset.toObject());
}

export async function getEquipmentDetail(id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound("Equipment");
  const asset = await Equipment.findById(id).lean();
  if (!asset) throw notFound("Equipment");

  const [docs, inspections, schedules, maintLogs, mobilizations, operators, expenses] = await Promise.all([
    ComplianceDocument.find({ "ownerRef.kind": "equipment", "ownerRef.id": asset._id })
      .sort({ isCurrent: -1, expiryDate: 1 })
      .lean(),
    EquipmentInspection.find({ equipmentId: asset._id }).sort({ inspectionDate: -1 }).lean(),
    MaintenanceSchedule.find({ "assetRef.kind": "equipment", "assetRef.id": asset._id }).lean(),
    MaintenanceLog.find({ "assetRef.kind": "equipment", "assetRef.id": asset._id }).sort({ date: -1 }).lean(),
    EquipmentMobilization.find({ equipmentId: asset._id }).sort({ mobilizationDate: -1 }).lean(),
    EquipmentOperatorAssignment.find({ equipmentId: asset._id }).sort({ startDate: -1 }).lean(),
    Expense.find({ "assetRef.kind": "equipment", "assetRef.id": asset._id }).sort({ date: -1 }).lean(),
  ]);

  const totalMaintenanceHalalas = maintLogs.reduce((sum, m) => sum + (m.costHalalas ?? 0), 0);
  const totalExpensesHalalas = expenses.reduce((sum, e) => sum + (e.amountHalalas ?? 0), 0);

  return {
    asset: toEquipmentDto(asset),
    documents: docs.map((d) => {
      const def = getDocumentTypeDefinition(d.docType);
      return {
        id: String(d._id),
        docType: d.docType,
        label: def?.label ?? d.docType,
        number: d.number ?? "",
        issueDate: dateDto(d.issueDate),
        expiryDate: dateDto(d.expiryDate),
        isCurrent: d.isCurrent,
        status: statusDto(expiryStatus(d.expiryDate)),
      };
    }),
    inspections: inspections.map((ins) => ({
      id: String(ins._id),
      inspectorName: ins.inspectorName,
      inspectionDate: dateDto(ins.inspectionDate),
      nextDueDate: dateDto(ins.nextDueDate),
      meterHours: ins.meterHours,
      odometerKm: ins.odometerKm,
      items: ins.items,
      overallResult: statusDto(ins.overallResult),
      autoMaintenanceTriggered: ins.autoMaintenanceTriggered,
      signatureText: ins.signatureText ?? "",
      notes: ins.notes ?? "",
    })),
    maintenanceSchedules: schedules.map((s) => {
      const hoursOverdue = s.nextDueHours !== undefined && s.nextDueHours !== null && s.nextDueHours > 0 && (asset.meterHours ?? 0) >= s.nextDueHours;
      const baseState = maintenanceStatus({
        nextDueDate: s.nextDueDate,
        nextDueKm: s.nextDueKm || 9999999,
        odometerKm: asset.odometerKm ?? 0,
      });
      const code = hoursOverdue ? "overdue" : baseState;
      return {
        id: String(s._id),
        serviceType: s.serviceType,
        intervalMonths: s.intervalMonths,
        intervalHours: s.intervalHours ?? 0,
        intervalKm: s.intervalKm ?? 0,
        nextDueDate: dateDto(s.nextDueDate),
        nextDueHours: s.nextDueHours ?? 0,
        nextDueKm: s.nextDueKm ?? 0,
        status: statusDto(code),
      };
    }),
    maintenanceLogs: maintLogs.map((m) => ({
      id: String(m._id),
      serviceType: m.serviceType,
      date: dateDto(m.date),
      meterHours: m.meterHours ?? 0,
      odometerKm: m.odometerKm ?? 0,
      workshop: m.workshop ?? "",
      cost: moneyDto(m.costHalalas),
      notes: m.notes ?? "",
    })),
    mobilizations: mobilizations.map((mob) => ({
      id: String(mob._id),
      clientName: mob.clientName,
      projectName: mob.projectName ?? "",
      siteLocation: mob.siteLocation,
      mobilizationDate: dateDto(mob.mobilizationDate),
      demobilizationDate: dateDto(mob.demobilizationDate),
      rateType: mob.rateType,
      rate: moneyDto(mob.rateHalalas),
      operatorName: mob.operatorName ?? "",
      status: statusDto(mob.status),
      notes: mob.notes ?? "",
    })),
    operators: operators.map((op) => ({
      id: String(op._id),
      employeeId: op.employeeId ? String(op.employeeId) : null,
      operatorName: op.operatorName,
      operatorMobile: op.operatorMobile ?? "",
      licenseOrCertNumber: op.licenseOrCertNumber ?? "",
      startDate: dateDto(op.startDate),
      endDate: dateDto(op.endDate),
      status: statusDto(op.status),
      complianceVerified: op.complianceVerified,
      notes: op.notes ?? "",
    })),
    expenses: expenses.map((ex) => ({
      id: String(ex._id),
      category: statusDto(ex.category),
      amount: moneyDto(ex.amountHalalas),
      date: dateDto(ex.date),
      notes: ex.notes ?? "",
    })),
    costSummary: {
      acquisitionOrRental: moneyDto(asset.purchaseOrRentalCostHalalas ?? 0),
      maintenance: moneyDto(totalMaintenanceHalalas),
      expenses: moneyDto(totalExpensesHalalas),
      totalOperating: moneyDto(totalMaintenanceHalalas + totalExpensesHalalas),
    },
  };
}

export async function addEquipmentDocument(equipmentId: string, input: z.infer<typeof equipmentDocBody>) {
  const asset = await Equipment.findById(equipmentId);
  if (!asset) throw notFound("Equipment");

  await ComplianceDocument.updateMany(
    {
      "ownerRef.kind": "equipment",
      "ownerRef.id": asset._id,
      docType: input.docType,
      isCurrent: true,
    },
    { $set: { isCurrent: false } },
  );

  const created = await ComplianceDocument.create({
    ownerRef: { kind: "equipment", id: asset._id },
    module: "equipment",
    docType: input.docType,
    number: input.number.trim(),
    issueDate: input.issueDate ? parseDateInput(input.issueDate) : undefined,
    expiryDate: parseDateInput(input.expiryDate),
    fileIds: input.fileIds.map((id) => new Types.ObjectId(id)),
    isCurrent: true,
  });

  return {
    id: String(created._id),
    docType: created.docType,
    number: created.number,
    expiryDate: dateDto(created.expiryDate),
    status: statusDto(expiryStatus(created.expiryDate)),
  };
}

export async function createEquipmentInspection(equipmentId: string, input: z.infer<typeof inspectionBody>) {
  const asset = await Equipment.findById(equipmentId);
  if (!asset) throw notFound("Equipment");

  const inspectionDate = parseDateInput(input.inspectionDate);
  const nextDueDate = input.nextDueDate ? parseDateInput(input.nextDueDate) : addDays(inspectionDate, 7);

  const failedCritical = input.items.filter((item) => item.critical && item.result === "fail");
  const anyFailed = input.items.some((item) => item.result === "fail");
  const overallResult = anyFailed ? "fail" : "pass";
  const autoMaintenanceTriggered = failedCritical.length > 0;

  const created = await EquipmentInspection.create({
    equipmentId: asset._id,
    inspectorName: input.inspectorName.trim(),
    inspectionDate,
    nextDueDate,
    meterHours: input.meterHours || asset.meterHours,
    odometerKm: input.odometerKm || asset.odometerKm,
    items: input.items,
    overallResult,
    autoMaintenanceTriggered,
    signatureText: input.signatureText.trim(),
    notes: input.notes.trim(),
  });

  if (input.meterHours > asset.meterHours) asset.meterHours = input.meterHours;
  if (input.odometerKm > asset.odometerKm) asset.odometerKm = input.odometerKm;

  if (autoMaintenanceTriggered) {
    asset.status = "in_maintenance";
    await MaintenanceLog.create({
      assetRef: { kind: "equipment", id: asset._id },
      date: inspectionDate,
      meterHours: asset.meterHours,
      odometerKm: asset.odometerKm,
      serviceType: "Critical Inspection Failure Repair",
      workshop: "Internal Maintenance Team",
      costHalalas: 0,
      notes: `Auto-generated from failed critical inspection items: ${failedCritical.map((i) => i.label).join(", ")}`,
    });
  }

  await asset.save();

  return {
    id: String(created._id),
    overallResult: statusDto(created.overallResult),
    autoMaintenanceTriggered: created.autoMaintenanceTriggered,
    equipmentStatus: statusDto(asset.status),
  };
}

export async function createEquipmentMaintenanceSchedule(
  equipmentId: string,
  input: z.infer<typeof equipmentMaintenanceScheduleBody>,
) {
  const asset = await Equipment.findById(equipmentId).lean();
  if (!asset) throw notFound("Equipment");

  const created = await MaintenanceSchedule.create({
    assetRef: { kind: "equipment", id: asset._id },
    serviceType: input.serviceType.trim(),
    intervalMonths: input.intervalMonths,
    intervalHours: input.intervalHours,
    intervalKm: input.intervalKm,
    nextDueDate: parseDateInput(input.nextDueDate),
    nextDueHours: input.nextDueHours ?? (asset.meterHours || 0) + input.intervalHours,
    nextDueKm: input.nextDueKm ?? (asset.odometerKm || 0) + input.intervalKm,
  });

  return { id: String(created._id), serviceType: created.serviceType };
}

export async function createEquipmentMaintenanceLog(
  equipmentId: string,
  input: z.infer<typeof equipmentMaintenanceLogBody>,
) {
  const asset = await Equipment.findById(equipmentId);
  if (!asset) throw notFound("Equipment");

  const date = parseDateInput(input.date);
  const created = await MaintenanceLog.create({
    assetRef: { kind: "equipment", id: asset._id },
    date,
    meterHours: input.meterHours || asset.meterHours,
    odometerKm: input.odometerKm || asset.odometerKm,
    serviceType: input.serviceType.trim(),
    workshop: input.workshop.trim(),
    costHalalas: sarToHalalas(input.costSar),
    notes: input.notes.trim(),
  });

  if (input.meterHours > asset.meterHours) asset.meterHours = input.meterHours;
  if (input.odometerKm > asset.odometerKm) asset.odometerKm = input.odometerKm;
  if (asset.status === "in_maintenance") asset.status = "available";
  await asset.save();

  return {
    id: String(created._id),
    serviceType: created.serviceType,
    cost: moneyDto(created.costHalalas),
  };
}

export async function listEquipmentMobilizations() {
  const [rows, assets] = await Promise.all([
    EquipmentMobilization.find().sort({ mobilizationDate: -1 }).lean(),
    Equipment.find().select("assetCode name categoryName").lean(),
  ]);
  const assetMap = new Map(assets.map((a) => [String(a._id), a]));

  return rows.map((m) => {
    const eq = assetMap.get(String(m.equipmentId));
    return {
      id: String(m._id),
      equipmentId: String(m.equipmentId),
      assetCode: eq?.assetCode ?? "",
      equipmentName: eq?.name ?? "",
      categoryName: eq?.categoryName ?? "",
      clientName: m.clientName,
      projectName: m.projectName ?? "",
      siteLocation: m.siteLocation,
      mobilizationDate: dateDto(m.mobilizationDate),
      demobilizationDate: dateDto(m.demobilizationDate),
      rateType: m.rateType,
      rate: moneyDto(m.rateHalalas),
      operatorName: m.operatorName ?? "",
      status: statusDto(m.status),
      notes: m.notes ?? "",
    };
  });
}

export async function createEquipmentMobilization(
  equipmentId: string,
  input: z.infer<typeof mobilizationBody>,
) {
  const asset = await Equipment.findById(equipmentId);
  if (!asset) throw notFound("Equipment");

  const startDate = parseDateInput(input.mobilizationDate);
  const endDate = input.demobilizationDate ? parseDateInput(input.demobilizationDate) : undefined;

  if (endDate && endDate < startDate) {
    throw new AppError(400, "INVALID_DATE_RANGE", "Demobilization date cannot be earlier than mobilization date");
  }

  // Block overlapping active or planned mobilizations for the same equipment
  if (input.status !== "completed") {
    const existingActive = await EquipmentMobilization.find({
      equipmentId: asset._id,
      status: { $in: ["active", "planned"] },
    }).lean();

    for (const ex of existingActive) {
      const exStart = ex.mobilizationDate;
      const exEnd = ex.demobilizationDate ?? addDays(exStart, 3650);
      const newEnd = endDate ?? addDays(startDate, 3650);

      if (startDate <= exEnd && newEnd >= exStart) {
        throw new AppError(
          409,
          "MOBILIZATION_OVERLAP",
          `This equipment already has an overlapping ${ex.status} mobilization to ${ex.clientName} (${ex.siteLocation}). Complete the existing mobilization first.`,
        );
      }
    }
  }

  const created = await EquipmentMobilization.create({
    equipmentId: asset._id,
    clientName: input.clientName.trim(),
    projectName: input.projectName.trim(),
    siteLocation: input.siteLocation.trim(),
    mobilizationDate: startDate,
    demobilizationDate: endDate,
    rateType: input.rateType,
    rateHalalas: sarToHalalas(input.rateSar),
    operatorName: input.operatorName.trim(),
    operatorEmployeeId: input.operatorEmployeeId ? new Types.ObjectId(input.operatorEmployeeId) : undefined,
    status: input.status,
    notes: input.notes.trim(),
  });

  if (input.status === "active") {
    asset.status = "mobilized";
    asset.currentLocation = input.siteLocation.trim();
    await asset.save();
  }

  return {
    id: String(created._id),
    clientName: created.clientName,
    siteLocation: created.siteLocation,
    status: statusDto(created.status),
  };
}

export async function updateEquipmentMobilization(
  mobilizationId: string,
  input: { status?: "planned" | "active" | "completed"; demobilizationDate?: string },
) {
  const mob = await EquipmentMobilization.findById(mobilizationId);
  if (!mob) throw notFound("Mobilization");

  if (input.status) mob.status = input.status;
  if (input.demobilizationDate) mob.demobilizationDate = parseDateInput(input.demobilizationDate);
  await mob.save();

  if (mob.status === "completed") {
    await Equipment.updateOne(
      { _id: mob.equipmentId, status: "mobilized" },
      { $set: { status: "available", currentLocation: "Main Yard" } },
    );
  }

  return {
    id: String(mob._id),
    status: statusDto(mob.status),
    demobilizationDate: dateDto(mob.demobilizationDate),
  };
}

export async function createEquipmentOperatorAssignment(
  equipmentId: string,
  input: z.infer<typeof operatorAssignmentBody>,
) {
  const companyId = requireCompanyId();
  const asset = await Equipment.findById(equipmentId).lean();
  if (!asset) throw notFound("Equipment");

  const company = await Company.findById(companyId).select("modules").lean();
  const hrEnabled = Boolean(company?.modules?.includes("hr"));

  let operatorName = input.operatorName.trim();
  const now = new Date();

  if (hrEnabled && input.employeeId) {
    const emp = await Employee.findById(input.employeeId).lean();
    if (!emp) throw notFound("Employee");
    operatorName = emp.nameEn;

    if (emp.employmentStatus === "terminated") {
      throw new AppError(400, "OPERATOR_NON_COMPLIANT", "Cannot assign a terminated employee as equipment operator.");
    }
    if (emp.iqamaExpiry < now) {
      throw new AppError(
        400,
        "OPERATOR_NON_COMPLIANT",
        `Operator ${emp.nameEn} has an expired Iqama (${formatRiyadhDate(emp.iqamaExpiry)}). Renew Iqama before assignment.`,
      );
    }

    const operatorDocs = await ComplianceDocument.find({
      "ownerRef.kind": "employee",
      "ownerRef.id": emp._id,
      docType: { $in: ["professional_certificate", "driving_license"] },
      isCurrent: true,
    }).lean();

    const expiredCert = operatorDocs.find((d) => d.expiryDate < now);
    if (expiredCert) {
      throw new AppError(
        400,
        "OPERATOR_NON_COMPLIANT",
        `Operator ${emp.nameEn} has an expired ${expiredCert.docType.replace(/_/g, " ")}.`,
      );
    }
  }

  await EquipmentOperatorAssignment.updateMany(
    { equipmentId: asset._id, status: "active" },
    { $set: { status: "completed", endDate: now } },
  );

  const created = await EquipmentOperatorAssignment.create({
    equipmentId: asset._id,
    employeeId: input.employeeId ? new Types.ObjectId(input.employeeId) : undefined,
    operatorName,
    operatorMobile: input.operatorMobile.trim(),
    licenseOrCertNumber: input.licenseOrCertNumber.trim(),
    startDate: parseDateInput(input.startDate),
    endDate: input.endDate ? parseDateInput(input.endDate) : undefined,
    status: "active",
    complianceVerified: true,
    notes: input.notes.trim(),
  });

  return {
    id: String(created._id),
    operatorName: created.operatorName,
    startDate: dateDto(created.startDate),
    status: statusDto(created.status),
  };
}

export async function createEquipmentExpense(
  equipmentId: string,
  input: z.infer<typeof equipmentExpenseBody>,
) {
  const asset = await Equipment.findById(equipmentId).lean();
  if (!asset) throw notFound("Equipment");

  const created = await Expense.create({
    assetRef: { kind: "equipment", id: asset._id },
    category: input.category,
    amountHalalas: sarToHalalas(input.amountSar),
    date: parseDateInput(input.date),
    notes: input.notes.trim(),
  });

  return {
    id: String(created._id),
    category: statusDto(created.category),
    amount: moneyDto(created.amountHalalas),
    date: dateDto(created.date),
  };
}

export async function listClientsAndProjects() {
  const [clients, projects] = await Promise.all([
    Client.find().sort({ name: 1 }).lean(),
    Project.find().sort({ name: 1 }).lean(),
  ]);

  return {
    clients: clients.map((c) => ({
      id: String(c._id),
      name: c.name,
      code: c.code,
      city: c.city,
      contactPerson: c.contactPerson,
      mobile: c.mobile,
      status: statusDto(c.status),
    })),
    projects: projects.map((p) => ({
      id: String(p._id),
      clientId: String(p.clientId),
      name: p.name,
      code: p.code,
      siteLocation: p.siteLocation,
      status: statusDto(p.status),
    })),
  };
}

export async function createClientAndProject(input: z.infer<typeof clientProjectBody>) {
  let client = await Client.findOne({ code: input.clientCode.trim().toUpperCase() });
  if (!client) {
    client = await Client.create({
      name: input.clientName.trim(),
      code: input.clientCode.trim().toUpperCase(),
      city: input.city.trim(),
      contactPerson: input.contactPerson.trim(),
      mobile: input.mobile.trim(),
      status: "active",
    });
  }

  let project = null;
  if (input.projectName && input.projectCode && input.siteLocation) {
    project = await Project.create({
      clientId: client._id,
      name: input.projectName.trim(),
      code: input.projectCode.trim().toUpperCase(),
      siteLocation: input.siteLocation.trim(),
      status: "active",
    });
  }

  return {
    client: { id: String(client._id), name: client.name, code: client.code },
    project: project ? { id: String(project._id), name: project.name, siteLocation: project.siteLocation } : null,
  };
}

export async function exportEquipmentExcel(query: Record<string, unknown>): Promise<Buffer> {
  const filter: Record<string, unknown> = {};
  if (typeof query.category === "string" && query.category.trim()) filter.categoryName = query.category.trim();
  if (typeof query.status === "string" && query.status.trim()) filter.status = query.status.trim();

  const rows = await Equipment.find(filter).sort({ assetCode: 1 }).lean();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Equipment");

  ws.columns = [
    { header: "Asset Code", key: "assetCode", width: 16 },
    { header: "Name", key: "name", width: 28 },
    { header: "Category", key: "categoryName", width: 18 },
    { header: "Make", key: "make", width: 16 },
    { header: "Model", key: "model", width: 16 },
    { header: "Serial No", key: "serialNumber", width: 20 },
    { header: "Year", key: "year", width: 10 },
    { header: "Capacity", key: "capacity", width: 14 },
    { header: "Ownership", key: "ownership", width: 14 },
    { header: "Status", key: "status", width: 16 },
    { header: "Meter (Hours)", key: "meterHours", width: 14 },
    { header: "Odometer (km)", key: "odometerKm", width: 14 },
    { header: "Location", key: "currentLocation", width: 20 },
    { header: "Cost (SAR)", key: "costSar", width: 16 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const r of rows) {
    const dto = toEquipmentDto(r);
    ws.addRow({
      assetCode: dto.assetCode,
      name: dto.name,
      categoryName: dto.categoryName,
      make: dto.make,
      model: dto.model,
      serialNumber: dto.serialNumber,
      year: dto.year,
      capacity: dto.capacity,
      ownership: dto.ownership.label,
      status: dto.status.label,
      meterHours: dto.meterHours,
      odometerKm: dto.odometerKm,
      currentLocation: dto.currentLocation,
      costSar: halalasToSar(r.purchaseOrRentalCostHalalas ?? 0),
    });
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export async function importEquipmentExcel(buffer: Buffer, dryRun: boolean) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const ws = wb.worksheets[0];
  if (!ws) throw new AppError(400, "INVALID_FILE", "Workbook has no worksheet");

  const cellText = (row: ExcelJS.Row, col: number): string => {
    const val = row.getCell(col).value;
    if (val === null || val === undefined) return "";
    if (typeof val === "object" && "text" in val) return String((val as any).text).trim();
    return String(val).trim();
  };

  const preview: Array<{
    rowNumber: number;
    assetCode: string;
    name: string;
    categoryName: string;
    serialNumber: string;
    valid: boolean;
    error?: string;
    parsed?: z.infer<typeof equipmentCreateBody>;
  }> = [];

  for (let i = 2; i <= ws.rowCount; i += 1) {
    const row = ws.getRow(i);
    const assetCode = cellText(row, 1);
    const name = cellText(row, 2);
    if (!assetCode && !name) continue;

    const raw = {
      assetCode,
      name,
      categoryName: cellText(row, 3) || "Crane",
      make: cellText(row, 4) || "Caterpillar",
      model: cellText(row, 5) || "Standard",
      serialNumber: cellText(row, 6) || `SN-${assetCode}`,
      year: Number(cellText(row, 7) || 2024),
      capacity: cellText(row, 8) || "",
      ownership: (cellText(row, 9).toLowerCase() || "owned") as any,
      meterHours: Number(cellText(row, 10) || 0),
      currentLocation: cellText(row, 11) || "Main Yard",
      purchaseOrRentalCostSar: Number(cellText(row, 12) || 0),
    };

    const parsed = equipmentCreateBody.safeParse(raw);
    if (!parsed.success) {
      preview.push({
        rowNumber: i,
        assetCode,
        name,
        categoryName: raw.categoryName,
        serialNumber: raw.serialNumber,
        valid: false,
        error: parsed.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`).join("; "),
      });
    } else {
      preview.push({
        rowNumber: i,
        assetCode: parsed.data.assetCode,
        name: parsed.data.name,
        categoryName: parsed.data.categoryName,
        serialNumber: parsed.data.serialNumber,
        valid: true,
        parsed: parsed.data,
      });
    }
  }

  let imported = 0;
  if (!dryRun) {
    for (const item of preview) {
      if (!item.valid || !item.parsed) continue;
      try {
        await createEquipmentAsset(item.parsed);
        imported += 1;
      } catch (err) {
        item.valid = false;
        item.error = err instanceof Error ? err.message : "Failed to import row";
      }
    }
  }

  return {
    dryRun,
    totalRows: preview.length,
    validRows: preview.filter((p) => p.valid).length,
    invalidRows: preview.filter((p) => !p.valid).length,
    imported,
    rows: preview.map(({ parsed: _p, ...rest }) => rest),
  };
}
