import ExcelJS from "exceljs";
import { Types } from "mongoose";
import { z } from "zod";
import { ComplianceDocument } from "../../core/documents/model";
import { getDocumentTypeDefinition } from "../../core/documents/registry";
import { Employee } from "../../core/employees/model";
import { assertWithinLimit } from "../../core/tenant/limits";
import { AuditLog } from "../audit/model";
import { getContext, requireCompanyId } from "../../lib/context";
import { decryptField, encryptField, hmacField } from "../../lib/crypto";
import { addDays, daysBetween, formatRiyadhDate, parseDateInput } from "../../lib/dates";
import { AppError, notFound } from "../../lib/errors";
import { halalasToSar, sarToHalalas } from "../../lib/money";
import { pageResult, parsePagination } from "../../lib/pagination";
import { formatSaudiMobile, maskIqama, maskMobile, normalizeSaudiMobile } from "../../lib/phone";
import { dateDto, moneyDto, statusDto } from "../../lib/present";
import { expiryStatus } from "../../lib/status";
import { isDuplicateKey } from "../../lib/tenantPlugin";
import { dateString, moneyInput, objectIdString, saudiIqama, saudiMobile } from "../../lib/zod";
import {
  EmployeeEvent,
  EmploymentContract,
  HrLookup,
  SalaryStructure,
  Sponsorship,
} from "./model";

function maskIdValue(value: string, visibleEnd = 4): string {
  const clean = value.trim();
  if (!clean) return "";
  if (clean.length <= visibleEnd) return clean;
  return `${"*".repeat(Math.max(4, clean.length - visibleEnd))}${clean.slice(-visibleEnd)}`;
}

function safeDecrypt(enc?: string | null): string {
  if (!enc) return "";
  try {
    return decryptField(enc);
  } catch {
    return "";
  }
}

export const employeeCreateBody = z.object({
  employeeNumber: z.string().trim().min(1).max(40),
  nameEn: z.string().trim().min(2).max(120),
  nameAr: z.string().trim().max(120).optional().default(""),
  mobile: saudiMobile,
  email: z.string().trim().email().optional().or(z.literal("")),
  iqamaNumber: saudiIqama,
  iqamaExpiry: dateString,
  passportNumber: z.string().trim().max(40).optional().default(""),
  passportExpiry: dateString.optional().or(z.literal("")),
  borderNumber: z.string().trim().max(40).optional().default(""),
  nationality: z.string().trim().min(2).max(60).default("Saudi"),
  gender: z.enum(["male", "female"]).default("male"),
  dateOfBirth: dateString.optional().or(z.literal("")),
  jobTitle: z.string().trim().max(80).default(""),
  department: z.string().trim().max(80).default(""),
  branch: z.string().trim().max(80).default("Riyadh"),
  employmentStatus: z.enum(["active", "on_leave", "probation", "terminated"]).default("active"),
  joinDate: dateString,
  probationEndDate: dateString.optional().or(z.literal("")),
  emergencyContact: z
    .object({
      name: z.string().trim().max(80).default(""),
      relation: z.string().trim().max(60).default(""),
      mobile: z.string().trim().max(30).default(""),
    })
    .optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

export const employeeUpdateBody = employeeCreateBody.partial();

export const employeeDocumentBody = z.object({
  docType: z.enum([
    "iqama",
    "passport",
    "border_number",
    "visa",
    "exit_reentry_permit",
    "medical_insurance",
    "driving_license",
    "professional_certificate",
  ]),
  number: z.string().trim().min(1).max(80),
  issueDate: dateString.optional().or(z.literal("")),
  expiryDate: dateString,
  fileIds: z.array(objectIdString).optional().default([]),
  notes: z.string().trim().max(500).optional().default(""),
});

export const sponsorshipBody = z.object({
  sponsorName: z.string().trim().min(2).max(120),
  sponsorFileNumber: z.string().trim().max(60).default(""),
  qiwaReference: z.string().trim().max(60).default(""),
  muqeemReference: z.string().trim().max(60).default(""),
  currentStatus: z.enum(["under_company", "transfer_pending", "transferred_out", "citizen"]).default("under_company"),
  newTransfer: z
    .object({
      fromSponsor: z.string().trim().min(1).max(120),
      toSponsor: z.string().trim().min(1).max(120),
      transferDate: dateString,
      referenceNumber: z.string().trim().max(60).default(""),
      notes: z.string().trim().max(400).default(""),
    })
    .optional(),
});

export const contractBody = z.object({
  contractType: z.enum(["fixed", "unlimited"]).default("fixed"),
  startDate: dateString,
  endDate: dateString.optional().or(z.literal("")),
  probationDays: z.coerce.number().int().min(0).max(365).default(90),
  noticePeriodDays: z.coerce.number().int().min(0).max(365).default(60),
  workingHoursPerWeek: z.coerce.number().int().min(1).max(80).default(48),
  position: z.string().trim().min(2).max(100),
  fileIds: z.array(objectIdString).optional().default([]),
  notes: z.string().trim().max(500).default(""),
});

export const salaryBody = z.object({
  effectiveDate: dateString,
  basicSar: moneyInput,
  housingSar: moneyInput.default(0),
  transportSar: moneyInput.default(0),
  otherAllowancesSar: moneyInput.default(0),
  commissionRule: z.string().trim().max(200).default(""),
  bankCode: z.string().trim().min(2).max(20).default("RJHI"),
  iban: z.string().trim().max(34).default(""),
  paymentMethod: z.enum(["wps_bank", "bank_transfer", "cash", "cheque"]).default("wps_bank"),
  notes: z.string().trim().max(500).default(""),
});

export const employeeEventBody = z.object({
  type: z.enum(["joined", "promoted", "transferred", "warning", "leave", "terminated"]),
  eventDate: dateString,
  title: z.string().trim().min(2).max(140),
  notes: z.string().trim().max(1000).default(""),
  fileIds: z.array(objectIdString).optional().default([]),
});

export const hrLookupBody = z.object({
  kind: z.enum(["department", "branch", "job_title"]),
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().max(30).default(""),
});

function toEmployeeDto(row: any, revealPii = false) {
  const mobilePlain = safeDecrypt(row.mobileEnc);
  const iqamaPlain = safeDecrypt(row.iqamaEnc);
  const passportPlain = safeDecrypt(row.passportEnc);
  const borderPlain = safeDecrypt(row.borderNumberEnc);
  const iqamaState = expiryStatus(row.iqamaExpiry);
  const passportState = row.passportExpiry ? expiryStatus(row.passportExpiry) : null;

  return {
    id: String(row._id),
    employeeNumber: row.employeeNumber,
    nameEn: row.nameEn,
    nameAr: row.nameAr ?? "",
    nationality: row.nationality ?? "Saudi",
    gender: row.gender ?? "male",
    dateOfBirth: dateDto(row.dateOfBirth),
    jobTitle: row.jobTitle ?? "",
    department: row.department ?? "",
    branch: row.branch ?? "",
    employmentStatus: statusDto(row.employmentStatus ?? "active"),
    joinDate: dateDto(row.joinDate),
    probationEndDate: dateDto(row.probationEndDate),
    mobileMasked: mobilePlain ? maskMobile(mobilePlain) : `•••• ${row.mobileLast4 ?? ""}`,
    mobile: revealPii && mobilePlain ? formatSaudiMobile(mobilePlain) : undefined,
    email: row.email ?? "",
    iqamaMasked: iqamaPlain ? maskIqama(iqamaPlain) : "••••••",
    iqamaNumber: revealPii ? iqamaPlain : undefined,
    iqamaExpiry: dateDto(row.iqamaExpiry),
    iqamaStatus: statusDto(iqamaState),
    passportMasked: passportPlain ? maskIdValue(passportPlain, 4) : "",
    passportNumber: revealPii ? passportPlain : undefined,
    passportExpiry: dateDto(row.passportExpiry),
    passportStatus: passportState ? statusDto(passportState) : null,
    borderNumberMasked: borderPlain ? maskIdValue(borderPlain, 4) : "",
    borderNumber: revealPii ? borderPlain : undefined,
    emergencyContact: row.emergencyContact ?? { name: "", relation: "", mobile: "" },
    customFields: row.customFields instanceof Map ? Object.fromEntries(row.customFields) : (row.customFields ?? {}),
  };
}

export async function getHrDashboard() {
  const now = new Date();
  const in30 = addDays(now, 30);
  const in60 = addDays(now, 60);
  const in90 = addDays(now, 90);

  const [employees, docs, contracts] = await Promise.all([
    Employee.find().lean(),
    ComplianceDocument.find({ "ownerRef.kind": "employee", isCurrent: true }).lean(),
    EmploymentContract.find({ isCurrent: true, contractType: "fixed", endDate: { $ne: null } }).lean(),
  ]);

  const byStatus: Record<string, number> = {
    active: 0,
    probation: 0,
    on_leave: 0,
    terminated: 0,
  };
  const byNationalityMap = new Map<string, number>();

  for (const emp of employees) {
    const st = emp.employmentStatus || "active";
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    if (st !== "terminated") {
      const nat = emp.nationality || "Saudi";
      byNationalityMap.set(nat, (byNationalityMap.get(nat) ?? 0) + 1);
    }
  }

  const byNationality = Array.from(byNationalityMap.entries())
    .map(([nationality, count]) => ({ nationality, count }))
    .sort((a, b) => b.count - a.count);

  const empMap = new Map(employees.map((e) => [String(e._id), e]));

  let expiring30 = 0;
  let expiring60 = 0;
  let expiring90 = 0;
  let expiredCount = 0;

  const upcomingExpiries: Array<{
    id: string;
    employeeId: string;
    employeeName: string;
    employeeNumber: string;
    docType: string;
    expiryDate: string | null;
    daysLeft: number;
    status: { code: string; label: string };
  }> = [];

  for (const emp of employees) {
    if (emp.employmentStatus === "terminated") continue;
    if (emp.iqamaExpiry) {
      const days = daysBetween(now, emp.iqamaExpiry);
      if (days < 0) expiredCount += 1;
      else if (days <= 30) expiring30 += 1;
      else if (days <= 60) expiring60 += 1;
      else if (days <= 90) expiring90 += 1;

      if (days <= 90) {
        upcomingExpiries.push({
          id: `iqama-${emp._id}`,
          employeeId: String(emp._id),
          employeeName: emp.nameEn,
          employeeNumber: emp.employeeNumber,
          docType: "Iqama",
          expiryDate: dateDto(emp.iqamaExpiry),
          daysLeft: days,
          status: statusDto(expiryStatus(emp.iqamaExpiry, now)),
        });
      }
    }
  }

  for (const doc of docs) {
    if (doc.docType === "iqama") continue;
    const emp = doc.ownerRef?.id ? empMap.get(String(doc.ownerRef.id)) : undefined;
    if (!emp || emp.employmentStatus === "terminated") continue;
    const days = daysBetween(now, doc.expiryDate);
    if (days < 0) expiredCount += 1;
    else if (days <= 30) expiring30 += 1;
    else if (days <= 60) expiring60 += 1;
    else if (days <= 90) expiring90 += 1;

    if (days <= 90) {
      const def = getDocumentTypeDefinition(doc.docType);
      upcomingExpiries.push({
        id: String(doc._id),
        employeeId: String(emp._id),
        employeeName: emp.nameEn,
        employeeNumber: emp.employeeNumber,
        docType: def?.label ?? doc.docType,
        expiryDate: dateDto(doc.expiryDate),
        daysLeft: days,
        status: statusDto(expiryStatus(doc.expiryDate, now)),
      });
    }
  }

  upcomingExpiries.sort((a, b) => a.daysLeft - b.daysLeft);

  const probationEndingSoon = employees
    .filter(
      (e) =>
        e.employmentStatus !== "terminated" &&
        e.probationEndDate &&
        e.probationEndDate >= now &&
        e.probationEndDate <= in30,
    )
    .map((e) => ({
      id: String(e._id),
      employeeNumber: e.employeeNumber,
      nameEn: e.nameEn,
      department: e.department ?? "",
      probationEndDate: dateDto(e.probationEndDate),
      daysLeft: daysBetween(now, e.probationEndDate!),
    }));

  const contractsEndingSoon = contracts
    .filter((c) => c.endDate && c.endDate >= now && c.endDate <= in60)
    .map((c) => {
      const emp = empMap.get(String(c.employeeId));
      return {
        id: String(c._id),
        employeeId: String(c.employeeId),
        employeeName: emp?.nameEn ?? "Employee",
        employeeNumber: emp?.employeeNumber ?? "",
        position: c.position,
        endDate: dateDto(c.endDate),
        daysLeft: daysBetween(now, c.endDate!),
      };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft);

  void in90;

  return {
    totalHeadcount: employees.filter((e) => e.employmentStatus !== "terminated").length,
    byStatus,
    byNationality,
    documentWindows: {
      expired: expiredCount,
      within30Days: expiring30,
      within60Days: expiring60,
      within90Days: expiring90,
    },
    upcomingExpiries: upcomingExpiries.slice(0, 20),
    probationEndingSoon,
    contractsEndingSoon,
  };
}

export async function listEmployees(query: Record<string, unknown>) {
  const { page, pageSize, skip } = parsePagination(query);
  const filter: Record<string, unknown> = {};

  if (typeof query.status === "string" && query.status.trim()) {
    filter.employmentStatus = query.status.trim();
  }
  if (typeof query.nationality === "string" && query.nationality.trim()) {
    filter.nationality = query.nationality.trim();
  }
  if (typeof query.department === "string" && query.department.trim()) {
    filter.department = query.department.trim();
  }
  if (typeof query.expiring === "string" && query.expiring.trim()) {
    const now = new Date();
    if (query.expiring === "expired") {
      filter.iqamaExpiry = { $lt: now };
    } else {
      const days = Number(query.expiring);
      if ([30, 60, 90].includes(days)) {
        filter.iqamaExpiry = { $lte: addDays(now, days) };
      }
    }
  }
  if (typeof query.q === "string" && query.q.trim()) {
    const q = query.q.trim();
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ employeeNumber: rx }, { nameEn: rx }, { nameAr: rx }, { jobTitle: rx }, { department: rx }];
  }

  const [rows, total] = await Promise.all([
    Employee.find(filter).sort({ employeeNumber: 1 }).skip(skip).limit(pageSize).lean(),
    Employee.countDocuments(filter),
  ]);

  return pageResult(
    rows.map((r) => toEmployeeDto(r, false)),
    total,
    page,
    pageSize,
  );
}

export async function createEmployee(input: z.infer<typeof employeeCreateBody>) {
  const companyId = requireCompanyId();
  await assertWithinLimit(companyId, "employees");

  const mobile = normalizeSaudiMobile(input.mobile);
  const iqama = input.iqamaNumber.trim();
  const passport = input.passportNumber?.trim() || "";
  const borderNumber = input.borderNumber?.trim() || "";
  const joinDate = parseDateInput(input.joinDate);
  const iqamaExpiry = parseDateInput(input.iqamaExpiry);
  const probationEndDate = input.probationEndDate
    ? parseDateInput(input.probationEndDate)
    : addDays(joinDate, 90);

  try {
    const created = await Employee.create({
      employeeNumber: input.employeeNumber.trim().toUpperCase(),
      nameEn: input.nameEn.trim(),
      nameAr: input.nameAr?.trim() ?? "",
      mobileEnc: encryptField(mobile),
      mobileHash: hmacField(mobile),
      mobileLast4: mobile.slice(-4),
      email: input.email ? input.email.toLowerCase().trim() : undefined,
      iqamaEnc: encryptField(iqama),
      iqamaHash: hmacField(iqama),
      iqamaExpiry,
      passportEnc: passport ? encryptField(passport) : undefined,
      passportHash: passport ? hmacField(passport) : undefined,
      passportExpiry: input.passportExpiry ? parseDateInput(input.passportExpiry) : undefined,
      borderNumberEnc: borderNumber ? encryptField(borderNumber) : undefined,
      borderNumberHash: borderNumber ? hmacField(borderNumber) : undefined,
      nationality: input.nationality.trim(),
      gender: input.gender,
      dateOfBirth: input.dateOfBirth ? parseDateInput(input.dateOfBirth) : undefined,
      jobTitle: input.jobTitle.trim(),
      department: input.department.trim(),
      branch: input.branch.trim(),
      employmentStatus: input.employmentStatus,
      joinDate,
      probationEndDate,
      emergencyContact: input.emergencyContact ?? { name: "", relation: "", mobile: "" },
      customFields: input.customFields ?? {},
    });

    await ComplianceDocument.create({
      ownerRef: { kind: "employee", id: created._id },
      module: "hr",
      docType: "iqama",
      number: maskIqama(iqama),
      issueDate: joinDate,
      expiryDate: iqamaExpiry,
      isCurrent: true,
    });

    if (passport && input.passportExpiry) {
      await ComplianceDocument.create({
        ownerRef: { kind: "employee", id: created._id },
        module: "hr",
        docType: "passport",
        number: maskIdValue(passport, 4),
        expiryDate: parseDateInput(input.passportExpiry),
        isCurrent: true,
      });
    }

    await EmployeeEvent.create({
      employeeId: created._id,
      type: "joined",
      eventDate: joinDate,
      title: `Joined as ${input.jobTitle || "Employee"}`,
      notes: `Department: ${input.department || "General"}, Branch: ${input.branch || "Riyadh"}`,
    });

    return toEmployeeDto(created.toObject(), true);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "DUPLICATE_EMPLOYEE", "Employee number, mobile number, or Iqama already exists");
    }
    throw error;
  }
}

export async function updateEmployee(id: string, input: z.infer<typeof employeeUpdateBody>) {
  const emp = await Employee.findById(id);
  if (!emp) throw notFound("Employee");

  if (input.employeeNumber !== undefined) emp.employeeNumber = input.employeeNumber.trim().toUpperCase();
  if (input.nameEn !== undefined) emp.nameEn = input.nameEn.trim();
  if (input.nameAr !== undefined) emp.nameAr = input.nameAr.trim();
  if (input.mobile !== undefined) {
    const mobile = normalizeSaudiMobile(input.mobile);
    emp.mobileEnc = encryptField(mobile);
    emp.mobileHash = hmacField(mobile);
    emp.mobileLast4 = mobile.slice(-4);
  }
  if (input.email !== undefined) emp.email = input.email ? input.email.toLowerCase().trim() : undefined;
  if (input.iqamaNumber !== undefined) {
    const iqama = input.iqamaNumber.trim();
    emp.iqamaEnc = encryptField(iqama);
    emp.iqamaHash = hmacField(iqama);
  }
  if (input.iqamaExpiry !== undefined && input.iqamaExpiry) {
    emp.iqamaExpiry = parseDateInput(input.iqamaExpiry);
  }
  if (input.passportNumber !== undefined) {
    const passport = input.passportNumber.trim();
    emp.passportEnc = passport ? encryptField(passport) : undefined;
    emp.passportHash = passport ? hmacField(passport) : undefined;
  }
  if (input.passportExpiry !== undefined) {
    emp.passportExpiry = input.passportExpiry ? parseDateInput(input.passportExpiry) : undefined;
  }
  if (input.borderNumber !== undefined) {
    const border = input.borderNumber.trim();
    emp.borderNumberEnc = border ? encryptField(border) : undefined;
    emp.borderNumberHash = border ? hmacField(border) : undefined;
  }
  if (input.nationality !== undefined) emp.nationality = input.nationality.trim();
  if (input.gender !== undefined) emp.gender = input.gender;
  if (input.dateOfBirth !== undefined) {
    emp.dateOfBirth = input.dateOfBirth ? parseDateInput(input.dateOfBirth) : undefined;
  }
  if (input.jobTitle !== undefined) emp.jobTitle = input.jobTitle.trim();
  if (input.department !== undefined) emp.department = input.department.trim();
  if (input.branch !== undefined) emp.branch = input.branch.trim();
  if (input.employmentStatus !== undefined) emp.employmentStatus = input.employmentStatus;
  if (input.joinDate !== undefined && input.joinDate) emp.joinDate = parseDateInput(input.joinDate);
  if (input.probationEndDate !== undefined) {
    emp.probationEndDate = input.probationEndDate ? parseDateInput(input.probationEndDate) : undefined;
  }
  if (input.emergencyContact !== undefined) {
    emp.emergencyContact = input.emergencyContact;
  }
  if (input.customFields !== undefined) {
    emp.customFields = new Map(Object.entries(input.customFields));
  }

  await emp.save();
  return toEmployeeDto(emp.toObject(), true);
}

export async function getEmployeeDetail(id: string, canReadSalary: boolean) {
  if (!Types.ObjectId.isValid(id)) throw notFound("Employee");
  const emp = await Employee.findById(id).lean();
  if (!emp) throw notFound("Employee");

  const [documents, sponsorship, contracts, events, salaries] = await Promise.all([
    ComplianceDocument.find({ "ownerRef.kind": "employee", "ownerRef.id": emp._id })
      .sort({ isCurrent: -1, expiryDate: 1 })
      .lean(),
    Sponsorship.findOne({ employeeId: emp._id }).lean(),
    EmploymentContract.find({ employeeId: emp._id }).sort({ version: -1 }).lean(),
    EmployeeEvent.find({ employeeId: emp._id }).sort({ eventDate: -1 }).lean(),
    canReadSalary ? SalaryStructure.find({ employeeId: emp._id }).sort({ effectiveDate: -1 }).lean() : Promise.resolve([]),
  ]);

  if (canReadSalary) {
    const ctx = getContext();
    if (ctx.companyId && ctx.userId) {
      await AuditLog.create({
        companyId: ctx.companyId,
        action: "READ",
        collectionName: "SalaryStructure",
        docId: String(emp._id),
        actorId: ctx.userId,
        actorRole: ctx.role || "unknown",
        before: null,
        after: { employeeId: String(emp._id), action: "employee_profile_salary_read" },
      }).catch(() => {});
    }
  }

  return {
    employee: toEmployeeDto(emp, true),
    documents: documents.map((d) => {
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
        fileIds: (d.fileIds ?? []).map(String),
      };
    }),
    sponsorship: sponsorship
      ? {
          id: String(sponsorship._id),
          sponsorName: sponsorship.sponsorName,
          sponsorFileNumber: sponsorship.sponsorFileNumber ?? "",
          qiwaReference: sponsorship.qiwaReference ?? "",
          muqeemReference: sponsorship.muqeemReference ?? "",
          currentStatus: statusDto(sponsorship.currentStatus ?? "under_company"),
          transferHistory: (sponsorship.transferHistory ?? []).map((t) => ({
            fromSponsor: t.fromSponsor,
            toSponsor: t.toSponsor,
            transferDate: dateDto(t.transferDate),
            referenceNumber: t.referenceNumber ?? "",
            notes: t.notes ?? "",
          })),
        }
      : null,
    contracts: contracts.map((c) => ({
      id: String(c._id),
      version: c.version,
      isCurrent: c.isCurrent,
      contractType: statusDto(c.contractType),
      startDate: dateDto(c.startDate),
      endDate: dateDto(c.endDate),
      endStatus: c.endDate ? statusDto(expiryStatus(c.endDate)) : null,
      probationDays: c.probationDays,
      noticePeriodDays: c.noticePeriodDays,
      workingHoursPerWeek: c.workingHoursPerWeek,
      position: c.position,
      fileIds: (c.fileIds ?? []).map(String),
      notes: c.notes ?? "",
    })),
    salaries: canReadSalary
      ? salaries.map((s) => ({
          id: String(s._id),
          effectiveDate: dateDto(s.effectiveDate),
          isCurrent: s.isCurrent,
          basic: moneyDto(s.basicHalalas),
          housing: moneyDto(s.housingHalalas),
          transport: moneyDto(s.transportHalalas),
          otherAllowances: moneyDto(s.otherAllowancesHalalas),
          total: moneyDto(s.totalHalalas),
          commissionRule: s.commissionRule ?? "",
          bankCode: s.bankCode ?? "RJHI",
          ibanMasked: s.ibanMasked ?? "",
          iban: safeDecrypt(s.ibanEnc),
          paymentMethod: s.paymentMethod,
          notes: s.notes ?? "",
        }))
      : null,
    events: events.map((ev) => ({
      id: String(ev._id),
      type: ev.type,
      eventDate: dateDto(ev.eventDate),
      title: ev.title,
      notes: ev.notes ?? "",
      fileIds: (ev.fileIds ?? []).map(String),
    })),
  };
}

export async function addEmployeeDocument(employeeId: string, input: z.infer<typeof employeeDocumentBody>) {
  const emp = await Employee.findById(employeeId);
  if (!emp) throw notFound("Employee");

  await ComplianceDocument.updateMany(
    {
      "ownerRef.kind": "employee",
      "ownerRef.id": emp._id,
      docType: input.docType,
      isCurrent: true,
    },
    { $set: { isCurrent: false } },
  );

  const expiry = parseDateInput(input.expiryDate);
  const storedNumber =
    input.docType === "passport" || input.docType === "border_number"
      ? maskIdValue(input.number, 4)
      : input.docType === "iqama"
        ? maskIqama(input.number)
        : input.number.trim();

  const doc = await ComplianceDocument.create({
    ownerRef: { kind: "employee", id: emp._id },
    module: "hr",
    docType: input.docType,
    number: storedNumber,
    issueDate: input.issueDate ? parseDateInput(input.issueDate) : undefined,
    expiryDate: expiry,
    fileIds: input.fileIds.map((id) => new Types.ObjectId(id)),
    isCurrent: true,
    metadata: input.notes ? { notes: input.notes } : {},
  });

  if (input.docType === "iqama") {
    emp.iqamaEnc = encryptField(input.number.trim());
    emp.iqamaHash = hmacField(input.number.trim());
    emp.iqamaExpiry = expiry;
    await emp.save();
  } else if (input.docType === "passport") {
    emp.passportEnc = encryptField(input.number.trim());
    emp.passportHash = hmacField(input.number.trim());
    emp.passportExpiry = expiry;
    await emp.save();
  } else if (input.docType === "border_number") {
    emp.borderNumberEnc = encryptField(input.number.trim());
    emp.borderNumberHash = hmacField(input.number.trim());
    await emp.save();
  }

  return {
    id: String(doc._id),
    docType: doc.docType,
    number: doc.number,
    issueDate: dateDto(doc.issueDate),
    expiryDate: dateDto(doc.expiryDate),
    status: statusDto(expiryStatus(doc.expiryDate)),
  };
}

export async function upsertEmployeeSponsorship(employeeId: string, input: z.infer<typeof sponsorshipBody>) {
  const emp = await Employee.findById(employeeId);
  if (!emp) throw notFound("Employee");

  let record = await Sponsorship.findOne({ employeeId: emp._id });
  if (!record) {
    record = new Sponsorship({
      employeeId: emp._id,
      sponsorName: input.sponsorName,
      sponsorFileNumber: input.sponsorFileNumber,
      qiwaReference: input.qiwaReference,
      muqeemReference: input.muqeemReference,
      currentStatus: input.currentStatus,
      transferHistory: [],
    });
  } else {
    record.sponsorName = input.sponsorName;
    record.sponsorFileNumber = input.sponsorFileNumber;
    record.qiwaReference = input.qiwaReference;
    record.muqeemReference = input.muqeemReference;
    record.currentStatus = input.currentStatus;
  }

  if (input.newTransfer) {
    record.transferHistory.push({
      fromSponsor: input.newTransfer.fromSponsor,
      toSponsor: input.newTransfer.toSponsor,
      transferDate: parseDateInput(input.newTransfer.transferDate),
      referenceNumber: input.newTransfer.referenceNumber,
      notes: input.newTransfer.notes,
    });
    await EmployeeEvent.create({
      employeeId: emp._id,
      type: "transferred",
      eventDate: parseDateInput(input.newTransfer.transferDate),
      title: `Sponsorship transferred from ${input.newTransfer.fromSponsor} to ${input.newTransfer.toSponsor}`,
      notes: input.newTransfer.notes || `Reference: ${input.newTransfer.referenceNumber}`,
    });
  }

  await record.save();
  return {
    id: String(record._id),
    sponsorName: record.sponsorName,
    sponsorFileNumber: record.sponsorFileNumber,
    qiwaReference: record.qiwaReference,
    muqeemReference: record.muqeemReference,
    currentStatus: statusDto(record.currentStatus),
  };
}

export async function createEmployeeContract(employeeId: string, input: z.infer<typeof contractBody>) {
  const emp = await Employee.findById(employeeId);
  if (!emp) throw notFound("Employee");

  const latest = await EmploymentContract.findOne({ employeeId: emp._id }).sort({ version: -1 }).lean();
  const nextVersion = (latest?.version ?? 0) + 1;

  await EmploymentContract.updateMany({ employeeId: emp._id, isCurrent: true }, { $set: { isCurrent: false } });

  const created = await EmploymentContract.create({
    employeeId: emp._id,
    version: nextVersion,
    isCurrent: true,
    contractType: input.contractType,
    startDate: parseDateInput(input.startDate),
    endDate: input.endDate ? parseDateInput(input.endDate) : undefined,
    probationDays: input.probationDays,
    noticePeriodDays: input.noticePeriodDays,
    workingHoursPerWeek: input.workingHoursPerWeek,
    position: input.position.trim(),
    fileIds: input.fileIds.map((id) => new Types.ObjectId(id)),
    notes: input.notes,
  });

  return {
    id: String(created._id),
    version: created.version,
    isCurrent: created.isCurrent,
    contractType: statusDto(created.contractType),
    startDate: dateDto(created.startDate),
    endDate: dateDto(created.endDate),
    position: created.position,
  };
}

export async function listEmployeeSalaries(employeeId: string) {
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) throw notFound("Employee");

  const rows = await SalaryStructure.find({ employeeId: emp._id }).sort({ effectiveDate: -1 }).lean();
  return rows.map((s) => ({
    id: String(s._id),
    effectiveDate: dateDto(s.effectiveDate),
    isCurrent: s.isCurrent,
    basic: moneyDto(s.basicHalalas),
    housing: moneyDto(s.housingHalalas),
    transport: moneyDto(s.transportHalalas),
    otherAllowances: moneyDto(s.otherAllowancesHalalas),
    total: moneyDto(s.totalHalalas),
    commissionRule: s.commissionRule ?? "",
    bankCode: s.bankCode ?? "RJHI",
    ibanMasked: s.ibanMasked ?? "",
    iban: safeDecrypt(s.ibanEnc),
    paymentMethod: s.paymentMethod,
    notes: s.notes ?? "",
  }));
}

export async function createEmployeeSalary(employeeId: string, input: z.infer<typeof salaryBody>) {
  const emp = await Employee.findById(employeeId);
  if (!emp) throw notFound("Employee");

  const basicHalalas = sarToHalalas(input.basicSar);
  const housingHalalas = sarToHalalas(input.housingSar);
  const transportHalalas = sarToHalalas(input.transportSar);
  const otherAllowancesHalalas = sarToHalalas(input.otherAllowancesSar);
  const totalHalalas = basicHalalas + housingHalalas + transportHalalas + otherAllowancesHalalas;

  const cleanIban = input.iban.replace(/\s+/g, "").toUpperCase();
  const ibanEnc = cleanIban ? encryptField(cleanIban) : "";
  const ibanMasked = cleanIban ? `SA${"*".repeat(Math.max(4, cleanIban.length - 6))}${cleanIban.slice(-4)}` : "";

  await SalaryStructure.updateMany({ employeeId: emp._id, isCurrent: true }, { $set: { isCurrent: false } });

  const created = await SalaryStructure.create({
    employeeId: emp._id,
    effectiveDate: parseDateInput(input.effectiveDate),
    isCurrent: true,
    basicHalalas,
    housingHalalas,
    transportHalalas,
    otherAllowancesHalalas,
    totalHalalas,
    commissionRule: input.commissionRule,
    bankCode: input.bankCode.toUpperCase(),
    ibanEnc,
    ibanMasked,
    paymentMethod: input.paymentMethod,
    notes: input.notes,
  });

  return {
    id: String(created._id),
    effectiveDate: dateDto(created.effectiveDate),
    isCurrent: created.isCurrent,
    basic: moneyDto(created.basicHalalas),
    housing: moneyDto(created.housingHalalas),
    transport: moneyDto(created.transportHalalas),
    otherAllowances: moneyDto(created.otherAllowancesHalalas),
    total: moneyDto(created.totalHalalas),
    bankCode: created.bankCode,
    ibanMasked: created.ibanMasked,
    paymentMethod: created.paymentMethod,
  };
}

export async function createEmployeeEvent(employeeId: string, input: z.infer<typeof employeeEventBody>) {
  const emp = await Employee.findById(employeeId);
  if (!emp) throw notFound("Employee");

  const created = await EmployeeEvent.create({
    employeeId: emp._id,
    type: input.type,
    eventDate: parseDateInput(input.eventDate),
    title: input.title.trim(),
    notes: input.notes,
    fileIds: input.fileIds.map((id) => new Types.ObjectId(id)),
  });

  if (input.type === "terminated") {
    emp.employmentStatus = "terminated";
    await emp.save();
  } else if (input.type === "leave") {
    emp.employmentStatus = "on_leave";
    await emp.save();
  }

  return {
    id: String(created._id),
    type: created.type,
    eventDate: dateDto(created.eventDate),
    title: created.title,
    notes: created.notes,
  };
}

export async function listHrLookups(kind?: string) {
  const filter: Record<string, unknown> = {};
  if (kind) filter.kind = kind;
  const rows = await HrLookup.find(filter).sort({ kind: 1, name: 1 }).lean();
  return rows.map((r) => ({
    id: String(r._id),
    kind: r.kind,
    name: r.name,
    code: r.code ?? "",
  }));
}

export async function createHrLookup(input: z.infer<typeof hrLookupBody>) {
  try {
    const row = await HrLookup.create({
      kind: input.kind,
      name: input.name.trim(),
      code: input.code.trim(),
    });
    return { id: String(row._id), kind: row.kind, name: row.name, code: row.code };
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "DUPLICATE_LOOKUP", "This lookup entry already exists");
    }
    throw error;
  }
}

export async function deleteHrLookup(id: string) {
  await HrLookup.deleteOne({ _id: id });
  return { deleted: true };
}

export async function exportEmployeesExcel(query: Record<string, unknown>, includeSalary: boolean): Promise<Buffer> {
  const filter: Record<string, unknown> = {};
  if (typeof query.status === "string" && query.status.trim()) filter.employmentStatus = query.status.trim();
  if (typeof query.nationality === "string" && query.nationality.trim()) filter.nationality = query.nationality.trim();
  if (typeof query.department === "string" && query.department.trim()) filter.department = query.department.trim();

  const employees = await Employee.find(filter).sort({ employeeNumber: 1 }).lean();
  const salaryMap = new Map<string, any>();

  if (includeSalary && employees.length > 0) {
    const salaries = await SalaryStructure.find({
      employeeId: { $in: employees.map((e) => e._id) },
      isCurrent: true,
    }).lean();
    for (const s of salaries) {
      salaryMap.set(String(s.employeeId), s);
    }
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Employees");

  const columns: Array<{ header: string; key: string; width: number }> = [
    { header: "Employee No", key: "employeeNumber", width: 16 },
    { header: "Name (EN)", key: "nameEn", width: 26 },
    { header: "Name (AR)", key: "nameAr", width: 26 },
    { header: "Nationality", key: "nationality", width: 16 },
    { header: "Job Title", key: "jobTitle", width: 22 },
    { header: "Department", key: "department", width: 18 },
    { header: "Branch", key: "branch", width: 16 },
    { header: "Status", key: "status", width: 14 },
    { header: "Join Date", key: "joinDate", width: 14 },
    { header: "Mobile (Masked)", key: "mobile", width: 18 },
    { header: "Iqama (Masked)", key: "iqama", width: 18 },
    { header: "Iqama Expiry", key: "iqamaExpiry", width: 14 },
  ];

  if (includeSalary) {
    columns.push(
      { header: "Basic (SAR)", key: "basicSar", width: 16 },
      { header: "Housing (SAR)", key: "housingSar", width: 16 },
      { header: "Transport (SAR)", key: "transportSar", width: 16 },
      { header: "Total Salary (SAR)", key: "totalSar", width: 18 },
      { header: "Bank", key: "bankCode", width: 12 },
      { header: "IBAN (Masked)", key: "ibanMasked", width: 24 },
    );
  }

  ws.columns = columns;
  ws.getRow(1).font = { bold: true };

  for (const emp of employees) {
    const dto = toEmployeeDto(emp, false);
    const sal = salaryMap.get(String(emp._id));
    const rowData: Record<string, unknown> = {
      employeeNumber: dto.employeeNumber,
      nameEn: dto.nameEn,
      nameAr: dto.nameAr,
      nationality: dto.nationality,
      jobTitle: dto.jobTitle,
      department: dto.department,
      branch: dto.branch,
      status: dto.employmentStatus.label,
      joinDate: emp.joinDate ? formatRiyadhDate(emp.joinDate) : "",
      mobile: dto.mobileMasked,
      iqama: dto.iqamaMasked,
      iqamaExpiry: emp.iqamaExpiry ? formatRiyadhDate(emp.iqamaExpiry) : "",
    };

    if (includeSalary) {
      rowData.basicSar = sal ? halalasToSar(sal.basicHalalas) : "0.00";
      rowData.housingSar = sal ? halalasToSar(sal.housingHalalas) : "0.00";
      rowData.transportSar = sal ? halalasToSar(sal.transportHalalas) : "0.00";
      rowData.totalSar = sal ? halalasToSar(sal.totalHalalas) : "0.00";
      rowData.bankCode = sal?.bankCode ?? "";
      rowData.ibanMasked = sal?.ibanMasked ?? "";
    }

    ws.addRow(rowData);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export async function importEmployeesExcel(buffer: Buffer, dryRun: boolean) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const ws = wb.worksheets[0];
  if (!ws) throw new AppError(400, "INVALID_FILE", "Workbook has no worksheet");

  const preview: Array<{
    rowNumber: number;
    employeeNumber: string;
    nameEn: string;
    nationality: string;
    department: string;
    valid: boolean;
    error?: string;
    parsed?: z.infer<typeof employeeCreateBody>;
  }> = [];

  const cellText = (row: ExcelJS.Row, col: number): string => {
    const val = row.getCell(col).value;
    if (val === null || val === undefined) return "";
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    if (typeof val === "object" && "text" in val) return String((val as any).text).trim();
    return String(val).trim();
  };

  for (let i = 2; i <= ws.rowCount; i += 1) {
    const row = ws.getRow(i);
    const employeeNumber = cellText(row, 1);
    const nameEn = cellText(row, 2);
    if (!employeeNumber && !nameEn) continue;

    const raw = {
      employeeNumber,
      nameEn,
      nameAr: cellText(row, 3),
      mobile: cellText(row, 4),
      iqamaNumber: cellText(row, 5),
      iqamaExpiry: cellText(row, 6) || "2027-12-31",
      nationality: cellText(row, 7) || "Saudi",
      jobTitle: cellText(row, 8) || "Staff",
      department: cellText(row, 9) || "Operations",
      branch: cellText(row, 10) || "Riyadh",
      joinDate: cellText(row, 11) || new Date().toISOString().slice(0, 10),
    };

    const parsed = employeeCreateBody.safeParse(raw);
    if (!parsed.success) {
      preview.push({
        rowNumber: i,
        employeeNumber,
        nameEn,
        nationality: raw.nationality,
        department: raw.department,
        valid: false,
        error: parsed.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`).join("; "),
      });
    } else {
      preview.push({
        rowNumber: i,
        employeeNumber: parsed.data.employeeNumber,
        nameEn: parsed.data.nameEn,
        nationality: parsed.data.nationality,
        department: parsed.data.department,
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
        await createEmployee(item.parsed);
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
