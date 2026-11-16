import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { LICENSE_TYPES, MAX_UPLOAD_BYTES, MODULES, type Module } from "../config/constants";
import { env } from "../config/env";
import { asyncHandler } from "../lib/asyncHandler";
import { requestContext } from "../lib/context";
import { AppError } from "../lib/errors";
import { authenticate } from "../middleware/authenticate";
import { buildLimiter } from "../middleware/rateLimit";
import { requireModule } from "../middleware/requireModule";
import { requirePermission } from "../middleware/requirePermission";
import { requireRole } from "../middleware/requireRole";
import { resolveUserPermissions } from "../core/auth/permissions";
import { RoleModel } from "../core/auth/roleModel";
import {
  complianceDocBody,
  createComplianceDocument,
  getComplianceDocument,
  listComplianceDocuments,
} from "../core/documents/service";
import { DOCUMENT_TYPE_REGISTRY } from "../core/documents/registry";
import {
  createCustomField,
  customFieldBody,
  deleteCustomField,
  listCustomFields,
} from "../core/customFields/service";
import { login, logout, refresh, requestOtp, requestSuperAdminCode, signInSuperAdminWithGoogle, superAdminAuthConfig, verifyOtp, verifySuperAdminCode } from "../modules/auth/service";
import { AuditLog } from "../modules/audit/model";
import { dismissAlert, listAlerts, listRules, listSms, updateRule, applyDeliveryReport } from "../modules/alerts/service";
import {
  companyAdminSchema,
  createCompany,
  enterSupportGrant,
  openFleet,
  getOwnCompany,
  grantSupport,
  listCompanies,
  listCompanyAuditLogs,
  listSupportGrants,
  updateCompany,
  updateOwnCompany,
} from "../modules/companies/service";
import { Company } from "../modules/companies/model";
import { User } from "../modules/users/model";
import { createCompanyAdmin, createGmailAccess, deleteGmailAccess, listGmailAccess, listUsers, updateGmailAccess, updateUserStatus } from "../modules/users/service";
import {
  assignDriver,
  createDriver,
  deleteDriver,
  driverBody,
  exportDrivers,
  getDriver,
  listAssignments,
  listDrivers,
  listHandovers,
  unassignDriver,
  updateDriver,
} from "../modules/drivers/service";
import { createPlan, exportEmi, listInstallments, listPlans, markInstallment, planBody } from "../modules/emi/service";
import { saveUpload, signedUrl, streamFile, tokenIsValid } from "../modules/files/service";
import { readVehicleDocument } from "../modules/documents/read";
import { createIstimara, exportIstimara, istimaraBody, listIstimara } from "../modules/istimara/service";
import { claimBody, createClaim, createPolicy, exportInsurance, listClaims, listPolicies, policyBody, updateClaimStatus } from "../modules/insurance/service";
import { createLog, createSchedule, exportMaintenance, listLogs, listSchedules, logBody, scheduleBody } from "../modules/maintenance/service";
import { myFuel, myMessageFile, myMessages, myProfile, myReply, myTrip, myUnread, myVehicle, myViolations, updateMyProfile, uploadMyMessageFile, uploadMyPhoto, verifyMyProfile } from "../modules/me/service";
import {
  createExpense,
  createFuel,
  createTrip,
  createViolation,
  expenseBody,
  exportRows,
  fuelBody,
  listExpenses,
  listFuel,
  listTrips,
  listViolations,
  setFuelApproval,
  tripBody,
  updateViolation,
  violationBody,
} from "../modules/operations/service";
import { attention, costs, search, summary, unpaid } from "../modules/dashboard/service";
import { runReport } from "../modules/reports/service";
import {
  commitImport,
  createVehicle,
  deleteVehicle,
  exportVehicles,
  getVehicle,
  importTemplate,
  listVehicles,
  previewImport,
  updateVehicle,
  vehicleBody,
} from "../modules/vehicles/service";
import { runDailyAlerts } from "../jobs/dailyAlerts";
import { broadcastBody, deleteDirectMessage, listDirectMessages, markReadByAdmin, messageBody, sendBroadcast, sendDirectMessage, unreadForAdmin, updateDirectMessage } from "../modules/messages/service";
import { hasPermission } from "../core/auth/permissions";
import {
  addEmployeeDocument,
  contractBody,
  createEmployee,
  createEmployeeContract,
  createEmployeeEvent,
  createEmployeeSalary,
  createHrLookup,
  deleteHrLookup,
  employeeCreateBody,
  employeeDocumentBody,
  employeeEventBody,
  employeeUpdateBody,
  exportEmployeesExcel,
  getEmployeeDetail,
  getHrDashboard,
  hrLookupBody,
  importEmployeesExcel,
  listEmployeeSalaries,
  listEmployees,
  listHrLookups,
  salaryBody,
  sponsorshipBody,
  updateEmployee,
  upsertEmployeeSponsorship,
} from "../modules/hr/service";
import {
  addEquipmentDocument,
  categoryBody,
  clientProjectBody,
  createClientAndProject,
  createEquipmentAsset,
  createEquipmentCategory,
  createEquipmentExpense,
  createEquipmentInspection,
  createEquipmentMaintenanceLog,
  createEquipmentMaintenanceSchedule,
  createEquipmentMobilization,
  createEquipmentOperatorAssignment,
  equipmentCreateBody,
  equipmentDocBody,
  equipmentExpenseBody,
  equipmentMaintenanceLogBody,
  equipmentMaintenanceScheduleBody,
  equipmentUpdateBody,
  exportEquipmentExcel,
  getEquipmentDashboard,
  getEquipmentDetail,
  importEquipmentExcel,
  inspectionBody,
  listClientsAndProjects,
  listEquipmentAssets,
  listEquipmentCategories,
  listEquipmentMobilizations,
  mobilizationBody,
  operatorAssignmentBody,
  updateEquipmentAsset,
  updateEquipmentMobilization,
} from "../modules/equipment/service";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

function uploadSingle(field: string) {
  const receive = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    const store = requestContext.getStore();
    receive(req, res, (error?: unknown) => {
      const done = () => next(error);
      if (store && requestContext.getStore() !== store) requestContext.run(store, done);
      else done();
    });
  };
}

function details(error: z.ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Check the highlighted fields", details(parsed.error));
  return parsed.data as z.output<S>;
}

function paging(query: Record<string, unknown>) {
  const filter = query.filter && typeof query.filter === "object" ? (query.filter as Record<string, string>) : {};
  return {
    page: Number(query.page ?? 1) || 1,
    limit: Number(query.limit ?? 20) || 20,
    q: query.q ? String(query.q) : undefined,
    sort: query.sort ? String(query.sort) : undefined,
    vehicleId: query.vehicleId ? String(query.vehicleId) : undefined,
    driverId: query.driverId ? String(query.driverId) : undefined,
    status: query.status ? String(query.status) : filter.status,
    category: query.category ? String(query.category) : undefined,
    from: query.from ? String(query.from) : undefined,
    to: query.to ? String(query.to) : undefined,
    filter,
  };
}

const admin = [authenticate, requireRole("company_admin", "super_admin")] as const;
const fleetAdmin = [authenticate, requireRole("company_admin", "super_admin"), requireModule("fleet")] as const;

export function mountRoutes(router: Router) {
  const authLimiter = buildLimiter(30);
  const otpLimiter = buildLimiter(10);

  router.post("/auth/login", authLimiter, asyncHandler(async (req, res) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const data = await login(body.email, body.password, res);
    res.json({ data });
  }));
  router.post("/auth/refresh", asyncHandler(async (req, res) => {
    const data = await refresh(req, res);
    res.json({ data });
  }));
  router.post("/auth/logout", asyncHandler(async (req, res) => {
    await logout(req, res);
    res.json({ data: { ok: true } });
  }));
  router.post("/auth/otp/request", otpLimiter, asyncHandler(async (req, res) => {
    const body = parse(z.object({ mobile: z.string().trim().min(7).max(24) }), req.body);
    res.json({ data: await requestOtp(body.mobile) });
  }));
  router.post("/auth/otp/verify", otpLimiter, asyncHandler(async (req, res) => {
    const body = parse(z.object({ mobile: z.string().trim().min(7).max(24), code: z.string().length(6) }), req.body);
    res.json({ data: await verifyOtp(body.mobile, body.code, res) });
  }));
  router.get("/auth/super-admin/config", asyncHandler(async (_req, res) => {
    res.json({ data: superAdminAuthConfig() });
  }));
  router.post("/auth/super-admin/google", otpLimiter, asyncHandler(async (req, res) => {
    const body = parse(z.object({
      credential: z.string().min(20).max(4096).optional(),
      email: z.string().trim().email().max(160).optional(),
    }), req.body);
    if (body.credential) {
      res.json({ data: await signInSuperAdminWithGoogle(body.credential, res) });
      return;
    }
    res.json({ data: await requestSuperAdminCode(body.email) });
  }));
  router.post("/auth/super-admin/verify", otpLimiter, asyncHandler(async (req, res) => {
    const body = parse(z.object({
      code: z.string().regex(/^\d{6}$/),
      email: z.string().trim().email().max(160).optional(),
    }), req.body);
    res.json({ data: await verifySuperAdminCode(body.code, res, body.email) });
  }));
  router.post("/auth/fleet", authenticate, requireRole("super_admin"), asyncHandler(async (_req, res) => {
    res.json({ data: await openFleet(res) });
  }));
  router.get("/auth/me", authenticate, asyncHandler(async (req, res) => {
    const user = await User.findById(req.ctx!.userId).lean();
    if (!user) throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
    const company = req.ctx?.companyId ? await Company.findById(req.ctx.companyId).lean() : null;
    const permissions = await resolveUserPermissions(user.role, req.ctx?.companyId ?? undefined);
    const modules = company?.modules && company.modules.length > 0
      ? company.modules
      : (user.role === "super_admin" ? ["fleet", "equipment", "hr", "payroll"] : ["fleet"]);

    res.json({
      data: {
        id: String(user._id),
        name: user.name,
        email: user.email ?? null,
        role: user.role,
        companyId: req.ctx?.companyId ?? null,
        companyName: company?.name ?? null,
        modules,
        permissions,
        limits: company?.limits ?? {
          vehicles: company?.maxVehicles ?? 500,
          equipment: 0,
          employees: 0,
          adminSeats: 5,
          smsCredits: company?.smsCredits ?? 0,
          storageMb: 5120,
        },
        driverId: req.ctx?.driverId ?? null,
        supportGrantId: req.ctx?.supportGrantId ?? null,
      },
    });
  }));

  // Platform Management (Super Admin)
  router.get("/platform/companies", authenticate, requireRole("super_admin"), asyncHandler(async (_req, res) => {
    res.json({ data: await listCompanies() });
  }));
  router.post("/platform/companies", authenticate, requireRole("super_admin"), asyncHandler(async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(160),
      plan: z.string().trim().max(40).optional(),
      modules: z.array(z.enum(MODULES)).optional(),
      limits: z.object({
        vehicles: z.coerce.number().int().min(1).optional(),
        equipment: z.coerce.number().int().min(0).optional(),
        employees: z.coerce.number().int().min(0).optional(),
        adminSeats: z.coerce.number().int().min(1).optional(),
        smsCredits: z.coerce.number().int().min(0).optional(),
        storageMb: z.coerce.number().int().min(100).optional(),
      }).optional(),
      maxVehicles: z.coerce.number().int().min(1).max(500).optional(),
      smsSenderName: z.string().trim().max(11).optional(),
      smsCredits: z.coerce.number().int().min(0).optional(),
      admin: companyAdminSchema,
    }), req.body);
    res.status(201).json({ data: await createCompany(body) });
  }));
  router.patch("/platform/companies/:id", authenticate, requireRole("super_admin"), asyncHandler(async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(160).optional(),
      status: z.enum(["active", "suspended"]).optional(),
      modules: z.array(z.enum(MODULES)).optional(),
      limits: z.object({
        vehicles: z.coerce.number().int().min(1).optional(),
        equipment: z.coerce.number().int().min(0).optional(),
        employees: z.coerce.number().int().min(0).optional(),
        adminSeats: z.coerce.number().int().min(1).optional(),
        smsCredits: z.coerce.number().int().min(0).optional(),
        storageMb: z.coerce.number().int().min(100).optional(),
      }).optional(),
      subscription: z.object({
        plan: z.string().optional(),
        status: z.enum(["trial", "active", "suspended", "expired"]).optional(),
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().optional(),
        notes: z.string().optional(),
      }).optional(),
      plan: z.string().trim().max(40).optional(),
      maxVehicles: z.coerce.number().int().min(1).max(500).optional(),
      smsSenderName: z.string().trim().max(11).optional(),
      smsCredits: z.coerce.number().int().min(0).optional(),
      driverPasswordLogin: z.boolean().optional(),
      confirmDowngrade: z.boolean().optional(),
    }), req.body);
    const actor = req.ctx ? { id: req.ctx.userId, email: req.ctx.role } : undefined;
    res.json({ data: await updateCompany(String(req.params.id), body, actor) });
  }));
  router.get("/platform/companies/:id/audit", authenticate, requireRole("super_admin"), asyncHandler(async (req, res) => {
    res.json({ data: await listCompanyAuditLogs(String(req.params.id)) });
  }));
  router.get("/platform/support-grants", authenticate, requireRole("super_admin"), asyncHandler(async (_req, res) => {
    res.json({ data: await listSupportGrants() });
  }));
  router.post("/platform/support-grants/:id/enter", authenticate, requireRole("super_admin"), asyncHandler(async (req, res) => {
    res.json({ data: await enterSupportGrant(String(req.params.id), res) });
  }));

  // Settings & Custom Roles
  router.get("/settings/company", ...admin, asyncHandler(async (_req, res) => {
    res.json({ data: await getOwnCompany() });
  }));
  router.patch("/settings/company", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(160).optional(),
      smsSenderName: z.string().trim().max(11).optional(),
      driverPasswordLogin: z.boolean().optional(),
    }), req.body);
    res.json({ data: await updateOwnCompany(body) });
  }));
  router.get("/settings/roles", ...admin, requirePermission("settings.roles.read"), asyncHandler(async (_req, res) => {
    const roles = await RoleModel.find().lean();
    res.json({
      data: roles.map((r) => ({
        id: String(r._id),
        key: r.key,
        name: r.name,
        description: r.description,
        permissions: r.permissions,
        isSystem: r.isSystem,
      })),
    });
  }));
  router.post("/settings/roles", ...admin, requirePermission("settings.roles.write"), asyncHandler(async (req, res) => {
    const body = parse(z.object({
      key: z.string().trim().min(1).max(40),
      name: z.string().trim().min(1).max(80),
      description: z.string().max(200).optional(),
      permissions: z.array(z.string()),
    }), req.body);
    const created = await RoleModel.create({ ...body, isSystem: false });
    res.status(201).json({ data: created });
  }));
  router.get("/settings/users", ...admin, asyncHandler(async (_req, res) => res.json({ data: await listUsers() })));
  router.post("/settings/users", ...admin, asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createCompanyAdmin(parse(companyAdminSchema, req.body)) });
  }));
  router.patch("/settings/users/:id", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({ status: z.enum(["active", "inactive"]) }), req.body);
    res.json({ data: await updateUserStatus(String(req.params.id), body.status) });
  }));
  router.get("/settings/gmail-access", authenticate, requireRole("super_admin"), asyncHandler(async (_req, res) => {
    res.json({ data: await listGmailAccess() });
  }));
  router.post("/settings/gmail-access", authenticate, requireRole("super_admin"), asyncHandler(async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(160),
      email: z.string().trim().email().max(160),
    }), req.body);
    res.status(201).json({ data: await createGmailAccess(body) });
  }));
  router.patch("/settings/gmail-access/:id", authenticate, requireRole("super_admin"), asyncHandler(async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(160).optional(),
      email: z.string().trim().email().max(160).optional(),
      status: z.enum(["active", "inactive"]).optional(),
    }), req.body);
    res.json({ data: await updateGmailAccess(String(req.params.id), body) });
  }));
  router.delete("/settings/gmail-access/:id", authenticate, requireRole("super_admin"), asyncHandler(async (req, res) => {
    res.json({ data: await deleteGmailAccess(String(req.params.id)) });
  }));
  router.post("/settings/support-access", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({ reason: z.string().trim().min(3).max(500), hours: z.coerce.number().int().min(1).max(72) }), req.body);
    res.status(201).json({ data: await grantSupport(body.reason, body.hours) });
  }));

  // Custom Field Definitions
  router.get("/settings/custom-fields", ...admin, requirePermission("settings.fields.read"), asyncHandler(async (req, res) => {
    res.json({ data: await listCustomFields(req.query.target as any) });
  }));
  router.post("/settings/custom-fields", ...admin, requirePermission("settings.fields.write"), asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createCustomField(parse(customFieldBody, req.body)) });
  }));
  router.delete("/settings/custom-fields/:id", ...admin, requirePermission("settings.fields.write"), asyncHandler(async (req, res) => {
    res.json({ data: await deleteCustomField(String(req.params.id)) });
  }));

  // Shared Compliance Document Engine
  router.get("/compliance/registry", ...admin, asyncHandler(async (_req, res) => {
    res.json({ data: DOCUMENT_TYPE_REGISTRY });
  }));
  router.get("/compliance/documents", ...admin, requirePermission("compliance.document.read"), asyncHandler(async (req, res) => {
    res.json({
      data: await listComplianceDocuments(
        req.query.kind as string,
        req.query.ownerId as string,
        req.query.docType as string,
      ),
    });
  }));
  router.post("/compliance/documents", ...admin, requirePermission("compliance.document.write"), asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createComplianceDocument(parse(complianceDocBody, req.body)) });
  }));
  router.get("/compliance/documents/:id", ...admin, requirePermission("compliance.document.read"), asyncHandler(async (req, res) => {
    res.json({ data: await getComplianceDocument(String(req.params.id)) });
  }));

  router.get("/audit", ...admin, asyncHandler(async (req, res) => {
    const query = paging(req.query as Record<string, unknown>);
    const rows = await AuditLog.find().sort({ at: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean();
    const total = await AuditLog.countDocuments();
    res.json({
      data: rows.map((row) => ({
        id: String(row._id),
        action: row.action,
        collectionName: row.collectionName,
        docId: row.docId,
        at: row.at,
        actorId: row.actorId ? String(row.actorId) : null,
      })),
      meta: { page: query.page, limit: query.limit, total },
    });
  }));

  // Fleet Module Routes (Gated by requireModule("fleet"))
  router.get("/vehicles/export.xlsx", ...fleetAdmin, requirePermission("fleet.vehicle.read"), asyncHandler(async (req, res) => {
    await exportVehicles(paging(req.query as Record<string, unknown>), res);
  }));
  router.get("/vehicles/import/template.xlsx", ...fleetAdmin, asyncHandler(async (_req, res) => {
    const buffer = await importTemplate();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=\"vehicle-import-template.xlsx\"");
    res.send(buffer);
  }));
  router.get("/vehicles", ...fleetAdmin, requirePermission("fleet.vehicle.read"), asyncHandler(async (req, res) => {
    res.json(await listVehicles(paging(req.query as Record<string, unknown>)));
  }));
  router.post("/vehicles", ...fleetAdmin, requirePermission("fleet.vehicle.write"), asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createVehicle(parse(vehicleBody, req.body)) });
  }));
  router.post("/vehicles/import", ...fleetAdmin, requirePermission("fleet.vehicle.write"), uploadSingle("file"), asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "INVALID_FILE", "Choose an Excel file");
    res.json({ data: await previewImport(req.file.buffer) });
  }));
  router.post("/vehicles/import/:id/commit", ...fleetAdmin, requirePermission("fleet.vehicle.write"), asyncHandler(async (req, res) => {
    res.json({ data: await commitImport(String(req.params.id)) });
  }));
  router.get("/vehicles/:id", ...fleetAdmin, requirePermission("fleet.vehicle.read"), asyncHandler(async (req, res) => {
    res.json({ data: await getVehicle(String(req.params.id)) });
  }));
  router.patch("/vehicles/:id", ...fleetAdmin, requirePermission("fleet.vehicle.write"), asyncHandler(async (req, res) => {
    res.json({ data: await updateVehicle(String(req.params.id), parse(vehicleBody.partial(), req.body)) });
  }));
  router.delete("/vehicles/:id", ...fleetAdmin, requirePermission("fleet.vehicle.write"), asyncHandler(async (req, res) => {
    res.json({ data: await deleteVehicle(String(req.params.id)) });
  }));

  router.get("/drivers/export.xlsx", ...admin, asyncHandler(async (req, res) => {
    await exportDrivers(paging(req.query as Record<string, unknown>), res);
  }));
  router.get("/drivers", ...admin, asyncHandler(async (req, res) => {
    res.json(await listDrivers(paging(req.query as Record<string, unknown>)));
  }));
  router.post("/drivers", ...admin, asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createDriver(parse(driverBody, req.body)) });
  }));
  router.get("/drivers/:id", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await getDriver(String(req.params.id)) });
  }));
  router.get("/messages/unread", ...admin, asyncHandler(async (_req, res) => {
    res.json({ data: await unreadForAdmin() });
  }));
  router.post("/messages/read", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({ driverId: z.string().regex(/^[a-f\d]{24}$/i) }), req.body);
    res.json({ data: await markReadByAdmin(body.driverId) });
  }));
  router.get("/messages", ...admin, asyncHandler(async (_req, res) => {
    res.json({ data: await listDirectMessages() });
  }));
  router.post("/messages/broadcast", ...admin, asyncHandler(async (req, res) => {
    res.status(201).json({ data: await sendBroadcast(parse(broadcastBody, req.body)) });
  }));
  router.post("/messages", ...admin, asyncHandler(async (req, res) => {
    res.status(201).json({ data: await sendDirectMessage(parse(messageBody, req.body)) });
  }));
  router.patch("/messages/:id", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await updateDirectMessage(String(req.params.id), parse(messageBody, req.body)) });
  }));
  router.delete("/messages/:id", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await deleteDirectMessage(String(req.params.id)) });
  }));
  router.patch("/drivers/:id", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await updateDriver(String(req.params.id), parse(driverBody.partial().extend({ status: z.enum(["active", "inactive"]).optional() }), req.body)) });
  }));
  router.delete("/drivers/:id", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await deleteDriver(String(req.params.id)) });
  }));
  router.post("/drivers/:id/assign", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({
      vehicleId: z.string().regex(/^[a-f\d]{24}$/i),
      date: z.coerce.date(),
      odometerKm: z.coerce.number().int().min(0),
      fuelLevel: z.string().max(40).optional(),
      notes: z.string().max(2000).optional(),
      fileIds: z.array(z.string()).optional(),
    }), req.body);
    res.status(201).json({ data: await assignDriver(String(req.params.id), body) });
  }));
  router.post("/drivers/:id/unassign", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({ date: z.coerce.date() }), req.body);
    res.json({ data: await unassignDriver(String(req.params.id), body.date) });
  }));
  router.get("/assignments", ...admin, asyncHandler(async (req, res) => {
    const query = paging(req.query as Record<string, unknown>);
    res.json({ data: await listAssignments(query.vehicleId, query.driverId) });
  }));
  router.get("/vehicles/:id/handovers", ...fleetAdmin, asyncHandler(async (req, res) => {
    res.json({ data: await listHandovers(String(req.params.id)) });
  }));

  router.get("/maintenance/schedules", ...fleetAdmin, requirePermission("fleet.maintenance.read"), asyncHandler(async (req, res) => {
    res.json(await listSchedules(paging(req.query as Record<string, unknown>)));
  }));
  router.post("/maintenance/schedules", ...fleetAdmin, requirePermission("fleet.maintenance.write"), asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createSchedule(parse(scheduleBody, req.body)) });
  }));
  router.get("/maintenance/logs", ...fleetAdmin, requirePermission("fleet.maintenance.read"), asyncHandler(async (req, res) => {
    res.json(await listLogs(paging(req.query as Record<string, unknown>)));
  }));
  router.post("/maintenance/logs", ...fleetAdmin, requirePermission("fleet.maintenance.write"), asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createLog(parse(logBody, req.body)) });
  }));
  router.get("/maintenance/export.xlsx", ...fleetAdmin, requirePermission("fleet.maintenance.read"), asyncHandler(async (_req, res) => exportMaintenance(res)));

  router.post("/documents/read", ...admin, uploadSingle("file"), asyncHandler(async (req, res) => {
    const rawKind = req.body?.kind;
    const kind =
      rawKind === "insurance"
        ? "insurance"
        : rawKind === "istimara"
          ? "istimara"
          : rawKind === "driver_license"
            ? "driver_license"
            : "";
    if (!kind) throw new AppError(400, "VALIDATION_ERROR", "Choose istimara, insurance, or driver_license");
    const vehicleId = typeof req.body?.vehicleId === "string" ? req.body.vehicleId : undefined;
    res.json({ data: await readVehicleDocument(req.file, kind, vehicleId) });
  }));
  router.get("/istimara", ...fleetAdmin, requirePermission("compliance.document.read"), asyncHandler(async (req, res) => res.json(await listIstimara(paging(req.query as Record<string, unknown>)))));
  router.post("/istimara", ...fleetAdmin, requirePermission("compliance.document.write"), asyncHandler(async (req, res) => res.status(201).json({ data: await createIstimara(parse(istimaraBody, req.body)) })));
  router.get("/istimara/export.xlsx", ...fleetAdmin, asyncHandler(async (_req, res) => exportIstimara(res)));

  router.get("/insurance/policies", ...fleetAdmin, requirePermission("compliance.document.read"), asyncHandler(async (req, res) => res.json(await listPolicies(paging(req.query as Record<string, unknown>)))));
  router.post("/insurance/policies", ...fleetAdmin, requirePermission("compliance.document.write"), asyncHandler(async (req, res) => res.status(201).json({ data: await createPolicy(parse(policyBody, req.body)) })));
  router.get("/insurance/claims", ...fleetAdmin, requirePermission("compliance.document.read"), asyncHandler(async (req, res) => res.json(await listClaims(paging(req.query as Record<string, unknown>)))));
  router.post("/insurance/claims", ...fleetAdmin, requirePermission("compliance.document.write"), asyncHandler(async (req, res) => res.status(201).json({ data: await createClaim(parse(claimBody, req.body)) })));
  router.patch("/insurance/claims/:id", ...fleetAdmin, requirePermission("compliance.document.write"), asyncHandler(async (req, res) => {
    const body = parse(z.object({ status: z.enum(["submitted", "approved", "rejected", "paid"]) }), req.body);
    res.json({ data: await updateClaimStatus(String(req.params.id), body.status) });
  }));
  router.get("/insurance/export.xlsx", ...fleetAdmin, asyncHandler(async (_req, res) => exportInsurance(res)));

  router.get("/emi/plans", ...fleetAdmin, requirePermission("fleet.emi.read"), asyncHandler(async (req, res) => res.json(await listPlans(paging(req.query as Record<string, unknown>)))));
  router.post("/emi/plans", ...fleetAdmin, requirePermission("fleet.emi.write"), asyncHandler(async (req, res) => res.status(201).json({ data: await createPlan(parse(planBody, req.body)) })));
  router.get("/emi/plans/:id/installments", ...fleetAdmin, requirePermission("fleet.emi.read"), asyncHandler(async (req, res) => res.json({ data: await listInstallments(String(req.params.id)) })));
  router.patch("/emi/installments/:id", ...fleetAdmin, requirePermission("fleet.emi.write"), asyncHandler(async (req, res) => {
    const body = parse(z.object({ status: z.enum(["paid", "unpaid"]), paidDate: z.coerce.date().optional() }), req.body);
    res.json({ data: await markInstallment(String(req.params.id), body.status, body.paidDate) });
  }));
  router.get("/emi/export.xlsx", ...fleetAdmin, asyncHandler(async (_req, res) => exportEmi(res)));

  router.get("/fuel", ...fleetAdmin, requirePermission("fleet.fuel.read"), asyncHandler(async (req, res) => res.json(await listFuel(paging(req.query as Record<string, unknown>)))));
  router.post("/fuel", ...fleetAdmin, requirePermission("fleet.fuel.write"), asyncHandler(async (req, res) => res.status(201).json({ data: await createFuel(parse(fuelBody, req.body)) })));
  router.patch("/fuel/:id", ...fleetAdmin, requirePermission("fleet.fuel.write"), asyncHandler(async (req, res) => {
    const body = parse(z.object({ approvalStatus: z.enum(["approved", "rejected"]) }), req.body);
    res.json({ data: await setFuelApproval(String(req.params.id), body.approvalStatus) });
  }));
  router.get("/fuel/export.xlsx", ...fleetAdmin, asyncHandler(async (_req, res) => exportRows(res, "fuel")));

  router.get("/violations", ...fleetAdmin, requirePermission("fleet.violation.read"), asyncHandler(async (req, res) => res.json(await listViolations(paging(req.query as Record<string, unknown>)))));
  router.post("/violations", ...fleetAdmin, requirePermission("fleet.violation.write"), asyncHandler(async (req, res) => res.status(201).json({ data: await createViolation(parse(violationBody, req.body)) })));
  router.patch("/violations/:id", ...fleetAdmin, requirePermission("fleet.violation.write"), asyncHandler(async (req, res) => {
    const body = parse(z.object({ status: z.enum(["unpaid", "paid", "disputed"]).optional(), deductFromDriver: z.boolean().optional() }), req.body);
    res.json({ data: await updateViolation(String(req.params.id), body) });
  }));
  router.get("/violations/export.xlsx", ...fleetAdmin, asyncHandler(async (_req, res) => exportRows(res, "violations")));

  router.get("/trips", ...fleetAdmin, requirePermission("fleet.trip.read"), asyncHandler(async (req, res) => res.json(await listTrips(paging(req.query as Record<string, unknown>)))));
  router.post("/trips", ...fleetAdmin, requirePermission("fleet.trip.write"), asyncHandler(async (req, res) => res.status(201).json({ data: await createTrip(parse(tripBody, req.body)) })));
  router.get("/trips/export.xlsx", ...fleetAdmin, asyncHandler(async (_req, res) => exportRows(res, "trips")));

  router.get("/expenses", ...fleetAdmin, requirePermission("fleet.expense.read"), asyncHandler(async (req, res) => res.json(await listExpenses(paging(req.query as Record<string, unknown>)))));
  router.post("/expenses", ...fleetAdmin, requirePermission("fleet.expense.write"), asyncHandler(async (req, res) => res.status(201).json({ data: await createExpense(parse(expenseBody, req.body)) })));
  router.get("/expenses/export.xlsx", ...fleetAdmin, asyncHandler(async (_req, res) => exportRows(res, "expenses")));

  router.post("/files", ...admin, uploadSingle("file"), asyncHandler(async (req, res) => {
    const moduleName = String(req.body?.module ?? "documents").replace(/[^\w-]/g, "").slice(0, 40) || "documents";
    res.status(201).json({ data: await saveUpload(req.file, moduleName) });
  }));
  router.get("/files/:id/url", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await signedUrl(String(req.params.id)) });
  }));
  router.get("/files/:id/download", asyncHandler(async (req, res) => {
    const token = req.query.token ? String(req.query.token) : undefined;
    if (!tokenIsValid(String(req.params.id), token)) throw new AppError(403, "FORBIDDEN", "This download link is invalid or expired");
    const range = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
    await streamFile(String(req.params.id), res, range);
  }));

  router.get("/alerts", ...admin, asyncHandler(async (req, res) => res.json(await listAlerts(paging(req.query as Record<string, unknown>)))));
  router.patch("/alerts/:id", ...admin, asyncHandler(async (req, res) => {
    parse(z.object({ status: z.literal("dismissed") }), req.body);
    res.json({ data: await dismissAlert(String(req.params.id)) });
  }));
  router.get("/alert-rules", ...admin, asyncHandler(async (_req, res) => res.json({ data: await listRules() })));
  router.patch("/alert-rules/:type", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({
      offsets: z.array(z.coerce.number().int().min(0)).max(8).optional(),
      enabled: z.boolean().optional(),
      recipients: z.array(z.enum(["admin", "driver"])).optional(),
    }), req.body);
    res.json({ data: await updateRule(String(req.params.type), body) });
  }));
  router.get("/sms-logs", ...admin, asyncHandler(async (req, res) => res.json(await listSms(paging(req.query as Record<string, unknown>)))));
  router.post("/alerts/run", ...admin, asyncHandler(async (_req, res) => {
    if (env.isProduction) throw new AppError(403, "FORBIDDEN", "The daily job runs on a schedule");
    await runDailyAlerts();
    res.json({ data: { ok: true } });
  }));
  router.post("/sms/delivery", asyncHandler(async (req, res) => {
    if (!env.SMS_WEBHOOK_SECRET || req.get("x-sms-secret") !== env.SMS_WEBHOOK_SECRET) {
      throw new AppError(403, "FORBIDDEN", "Invalid webhook secret");
    }
    res.json({ data: await applyDeliveryReport(req.body) });
  }));

  router.get("/dashboard/summary", ...admin, asyncHandler(async (_req, res) => res.json({ data: await summary() })));
  router.get("/dashboard/attention", ...admin, asyncHandler(async (_req, res) => res.json({ data: await attention() })));
  router.get("/dashboard/costs", ...admin, asyncHandler(async (_req, res) => res.json({ data: await costs() })));
  router.get("/dashboard/unpaid", ...admin, asyncHandler(async (_req, res) => res.json({ data: await unpaid() })));
  router.get("/dashboard/search", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await search(String(req.query.q ?? "")) });
  }));

  router.get("/reports/:name/export.xlsx", ...admin, requirePermission("reports.export"), asyncHandler(async (req, res) => {
    await runReport(String(req.params.name), paging(req.query as Record<string, unknown>), res);
  }));
  router.get("/reports/:name", ...admin, requirePermission("reports.read"), asyncHandler(async (req, res) => {
    res.json(await runReport(String(req.params.name), paging(req.query as Record<string, unknown>)));
  }));

  // Driver Self Portal
  router.get("/me/profile", authenticate, requireRole("driver"), asyncHandler(async (_req, res) => {
    res.json({ data: await myProfile() });
  }));
  router.patch("/me/profile", authenticate, requireRole("driver"), asyncHandler(async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(120).optional(),
      mobile: z.string().trim().min(7).max(24).optional(),
      iqamaNumber: z.string().trim().regex(/^\d{10}$/, "Iqama number must be 10 digits").optional(),
      iqamaExpiry: z.string().trim().min(1).optional(),
      licenseNumber: z.string().trim().min(3).max(30).optional(),
      licenseType: z.enum(LICENSE_TYPES).optional(),
      licenseExpiry: z.string().trim().min(1).optional(),
    }), req.body);
    res.json({ data: await updateMyProfile(body) });
  }));
  router.post("/me/profile/verify", authenticate, requireRole("driver"), asyncHandler(async (_req, res) => {
    res.json({ data: await verifyMyProfile() });
  }));
  router.post("/me/photo", authenticate, requireRole("driver"), uploadSingle("file"), asyncHandler(async (req, res) => {
    const saved = req.ctx;
    const run = async () => {
      const store = requestContext.getStore();
      if (store && saved) {
        store.userId ??= saved.userId;
        store.role ??= saved.role;
        store.companyId ??= saved.companyId;
        store.driverId ??= saved.driverId;
      }
      res.json({ data: await uploadMyPhoto(req.file) });
    };
    if (requestContext.getStore() || !saved) await run();
    else {
      await requestContext.run(
        { userId: saved.userId, role: saved.role, companyId: saved.companyId, driverId: saved.driverId },
        run,
      );
    }
  }));
  router.get("/me/messages/unread", authenticate, requireRole("driver"), asyncHandler(async (_req, res) => {
    res.json({ data: await myUnread() });
  }));
  router.get("/me/messages", authenticate, requireRole("driver"), asyncHandler(async (_req, res) => {
    res.json({ data: await myMessages() });
  }));
  router.get("/me/messages/files/:id/url", authenticate, requireRole("driver"), asyncHandler(async (req, res) => {
    res.json({ data: await myMessageFile(String(req.params.id)) });
  }));
  router.post("/me/messages/files", authenticate, requireRole("driver"), uploadSingle("file"), asyncHandler(async (req, res) => {
    const saved = req.ctx;
    const run = async () => {
      const store = requestContext.getStore();
      if (store && saved) {
        store.userId ??= saved.userId;
        store.role ??= saved.role;
        store.companyId ??= saved.companyId;
        store.driverId ??= saved.driverId;
      }
      res.status(201).json({ data: await uploadMyMessageFile(req.file) });
    };
    if (requestContext.getStore() || !saved) await run();
    else {
      await requestContext.run(
        { userId: saved.userId, role: saved.role, companyId: saved.companyId, driverId: saved.driverId },
        run,
      );
    }
  }));
  router.post("/me/messages", authenticate, requireRole("driver"), asyncHandler(async (req, res) => {
    const body = parse(z.object({
      body: z.string().trim().max(500).optional().default(""),
      fileIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(12).optional(),
    }).refine((value) => value.body.length > 0 || (value.fileIds?.length ?? 0) > 0, {
      message: "Write a message or add a file",
      path: ["body"],
    }), req.body);
    res.status(201).json({ data: await myReply(body.body ?? "", body.fileIds ?? []) });
  }));
  router.get("/me/vehicle", authenticate, requireRole("driver"), asyncHandler(async (_req, res) => {
    res.json({ data: await myVehicle() });
  }));
  router.get("/me/violations", authenticate, requireRole("driver"), asyncHandler(async (_req, res) => {
    res.json({ data: await myViolations() });
  }));
  router.post("/me/fuel", authenticate, requireRole("driver"), asyncHandler(async (req, res) => {
    res.status(201).json({ data: await myFuel(req.body) });
  }));
  router.post("/me/trips", authenticate, requireRole("driver"), asyncHandler(async (req, res) => {
    res.status(201).json({ data: await myTrip(req.body) });
  }));

  // =========================================================================
  // Phase 1: HR Core Module (/api/v1/hr/*)
  // =========================================================================
  const hrGuard = [authenticate, requireModule("hr")] as const;

  router.get(
    "/hr/dashboard",
    ...hrGuard,
    requirePermission("hr.employee.read"),
    asyncHandler(async (_req, res) => {
      res.json({ data: await getHrDashboard() });
    }),
  );

  router.get(
    "/hr/employees",
    ...hrGuard,
    requirePermission("hr.employee.read"),
    asyncHandler(async (req, res) => {
      res.json(await listEmployees(req.query as Record<string, unknown>));
    }),
  );

  router.post(
    "/hr/employees",
    ...hrGuard,
    requirePermission("hr.employee.write"),
    asyncHandler(async (req, res) => {
      const body = parse(employeeCreateBody, req.body);
      res.status(201).json({ data: await createEmployee(body) });
    }),
  );

  router.get(
    "/hr/employees/export.xlsx",
    ...hrGuard,
    requirePermission("hr.employee.read"),
    asyncHandler(async (req, res) => {
      const perms = await resolveUserPermissions(req.ctx!.role, req.ctx?.companyId ?? undefined);
      const includeSalary = req.ctx!.role === "super_admin" || hasPermission(perms, "hr.salary.read");
      const buffer = await exportEmployeesExcel(req.query as Record<string, unknown>, includeSalary);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="employees.xlsx"');
      res.send(buffer);
    }),
  );

  router.post(
    "/hr/employees/import",
    ...hrGuard,
    requirePermission("hr.employee.write"),
    uploadSingle("file"),
    asyncHandler(async (req, res) => {
      if (!req.file?.buffer) throw new AppError(400, "MISSING_FILE", "Attach an Excel (.xlsx) file");
      const dryRun = String(req.query.dryRun ?? req.body?.dryRun ?? "true") !== "false";
      res.json({ data: await importEmployeesExcel(req.file.buffer, dryRun) });
    }),
  );

  router.get(
    "/hr/employees/:id",
    ...hrGuard,
    requirePermission("hr.employee.read"),
    asyncHandler(async (req, res) => {
      const perms = await resolveUserPermissions(req.ctx!.role, req.ctx?.companyId ?? undefined);
      const canReadSalary = req.ctx!.role === "super_admin" || hasPermission(perms, "hr.salary.read");
      res.json({ data: await getEmployeeDetail(String(req.params.id), canReadSalary) });
    }),
  );

  router.patch(
    "/hr/employees/:id",
    ...hrGuard,
    requirePermission("hr.employee.write"),
    asyncHandler(async (req, res) => {
      const body = parse(employeeUpdateBody, req.body);
      res.json({ data: await updateEmployee(String(req.params.id), body) });
    }),
  );

  router.post(
    "/hr/employees/:id/documents",
    ...hrGuard,
    requirePermission("hr.document.write"),
    asyncHandler(async (req, res) => {
      const body = parse(employeeDocumentBody, req.body);
      res.status(201).json({ data: await addEmployeeDocument(String(req.params.id), body) });
    }),
  );

  router.put(
    "/hr/employees/:id/sponsorship",
    ...hrGuard,
    requirePermission("hr.sponsorship.write"),
    asyncHandler(async (req, res) => {
      const body = parse(sponsorshipBody, req.body);
      res.json({ data: await upsertEmployeeSponsorship(String(req.params.id), body) });
    }),
  );

  router.post(
    "/hr/employees/:id/contracts",
    ...hrGuard,
    requirePermission("hr.contract.write"),
    asyncHandler(async (req, res) => {
      const body = parse(contractBody, req.body);
      res.status(201).json({ data: await createEmployeeContract(String(req.params.id), body) });
    }),
  );

  router.get(
    "/hr/employees/:id/salary",
    ...hrGuard,
    requirePermission("hr.salary.read"),
    asyncHandler(async (req, res) => {
      res.json({ data: await listEmployeeSalaries(String(req.params.id)) });
    }),
  );

  router.post(
    "/hr/employees/:id/salary",
    ...hrGuard,
    requirePermission("hr.salary.write"),
    asyncHandler(async (req, res) => {
      const body = parse(salaryBody, req.body);
      res.status(201).json({ data: await createEmployeeSalary(String(req.params.id), body) });
    }),
  );

  router.post(
    "/hr/employees/:id/events",
    ...hrGuard,
    requirePermission("hr.employee.write"),
    asyncHandler(async (req, res) => {
      const body = parse(employeeEventBody, req.body);
      res.status(201).json({ data: await createEmployeeEvent(String(req.params.id), body) });
    }),
  );

  router.get(
    "/hr/lookups",
    ...hrGuard,
    requirePermission("hr.employee.read"),
    asyncHandler(async (req, res) => {
      res.json({ data: await listHrLookups(req.query.kind ? String(req.query.kind) : undefined) });
    }),
  );

  router.post(
    "/hr/lookups",
    ...hrGuard,
    requirePermission("hr.employee.write"),
    asyncHandler(async (req, res) => {
      const body = parse(hrLookupBody, req.body);
      res.status(201).json({ data: await createHrLookup(body) });
    }),
  );

  router.delete(
    "/hr/lookups/:id",
    ...hrGuard,
    requirePermission("hr.employee.write"),
    asyncHandler(async (req, res) => {
      res.json({ data: await deleteHrLookup(String(req.params.id)) });
    }),
  );

  // =========================================================================
  // Phase 2: Equipment Module (/api/v1/equipment/*)
  // =========================================================================
  const equipGuard = [authenticate, requireModule("equipment")] as const;

  router.get(
    "/equipment/dashboard",
    ...equipGuard,
    requirePermission("equipment.asset.read"),
    asyncHandler(async (_req, res) => {
      res.json({ data: await getEquipmentDashboard() });
    }),
  );

  router.get(
    "/equipment/categories",
    ...equipGuard,
    requirePermission("equipment.asset.read"),
    asyncHandler(async (_req, res) => {
      res.json({ data: await listEquipmentCategories() });
    }),
  );

  router.post(
    "/equipment/categories",
    ...equipGuard,
    requirePermission("equipment.asset.write"),
    asyncHandler(async (req, res) => {
      const body = parse(categoryBody, req.body);
      res.status(201).json({ data: await createEquipmentCategory(body) });
    }),
  );

  router.get(
    "/equipment/assets",
    ...equipGuard,
    requirePermission("equipment.asset.read"),
    asyncHandler(async (req, res) => {
      res.json(await listEquipmentAssets(req.query as Record<string, unknown>));
    }),
  );

  router.post(
    "/equipment/assets",
    ...equipGuard,
    requirePermission("equipment.asset.write"),
    asyncHandler(async (req, res) => {
      const body = parse(equipmentCreateBody, req.body);
      res.status(201).json({ data: await createEquipmentAsset(body) });
    }),
  );

  router.get(
    "/equipment/assets/export.xlsx",
    ...equipGuard,
    requirePermission("equipment.asset.read"),
    asyncHandler(async (req, res) => {
      const buffer = await exportEquipmentExcel(req.query as Record<string, unknown>);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="equipment.xlsx"');
      res.send(buffer);
    }),
  );

  router.post(
    "/equipment/assets/import",
    ...equipGuard,
    requirePermission("equipment.asset.write"),
    uploadSingle("file"),
    asyncHandler(async (req, res) => {
      if (!req.file?.buffer) throw new AppError(400, "MISSING_FILE", "Attach an Excel (.xlsx) file");
      const dryRun = String(req.query.dryRun ?? req.body?.dryRun ?? "true") !== "false";
      res.json({ data: await importEquipmentExcel(req.file.buffer, dryRun) });
    }),
  );

  router.get(
    "/equipment/assets/:id",
    ...equipGuard,
    requirePermission("equipment.asset.read"),
    asyncHandler(async (req, res) => {
      res.json({ data: await getEquipmentDetail(String(req.params.id)) });
    }),
  );

  router.patch(
    "/equipment/assets/:id",
    ...equipGuard,
    requirePermission("equipment.asset.write"),
    asyncHandler(async (req, res) => {
      const body = parse(equipmentUpdateBody, req.body);
      res.json({ data: await updateEquipmentAsset(String(req.params.id), body) });
    }),
  );

  router.post(
    "/equipment/assets/:id/documents",
    ...equipGuard,
    requirePermission("equipment.asset.write"),
    asyncHandler(async (req, res) => {
      const body = parse(equipmentDocBody, req.body);
      res.status(201).json({ data: await addEquipmentDocument(String(req.params.id), body) });
    }),
  );

  router.post(
    "/equipment/assets/:id/inspections",
    ...equipGuard,
    requirePermission("equipment.inspection.write"),
    asyncHandler(async (req, res) => {
      const body = parse(inspectionBody, req.body);
      res.status(201).json({ data: await createEquipmentInspection(String(req.params.id), body) });
    }),
  );

  router.post(
    "/equipment/assets/:id/maintenance/schedules",
    ...equipGuard,
    requirePermission("equipment.asset.write"),
    asyncHandler(async (req, res) => {
      const body = parse(equipmentMaintenanceScheduleBody, req.body);
      res.status(201).json({ data: await createEquipmentMaintenanceSchedule(String(req.params.id), body) });
    }),
  );

  router.post(
    "/equipment/assets/:id/maintenance/logs",
    ...equipGuard,
    requirePermission("equipment.asset.write"),
    asyncHandler(async (req, res) => {
      const body = parse(equipmentMaintenanceLogBody, req.body);
      res.status(201).json({ data: await createEquipmentMaintenanceLog(String(req.params.id), body) });
    }),
  );

  router.get(
    "/equipment/mobilizations",
    ...equipGuard,
    requirePermission("equipment.mobilization.read"),
    asyncHandler(async (_req, res) => {
      res.json({ data: await listEquipmentMobilizations() });
    }),
  );

  router.post(
    "/equipment/assets/:id/mobilizations",
    ...equipGuard,
    requirePermission("equipment.mobilization.write"),
    asyncHandler(async (req, res) => {
      const body = parse(mobilizationBody, req.body);
      res.status(201).json({ data: await createEquipmentMobilization(String(req.params.id), body) });
    }),
  );

  router.patch(
    "/equipment/mobilizations/:id",
    ...equipGuard,
    requirePermission("equipment.mobilization.write"),
    asyncHandler(async (req, res) => {
      const body = parse(
        z.object({
          status: z.enum(["planned", "active", "completed"]).optional(),
          demobilizationDate: z.string().optional(),
        }),
        req.body,
      );
      res.json({ data: await updateEquipmentMobilization(String(req.params.id), body) });
    }),
  );

  router.post(
    "/equipment/assets/:id/operators",
    ...equipGuard,
    requirePermission("equipment.operator.write"),
    asyncHandler(async (req, res) => {
      const body = parse(operatorAssignmentBody, req.body);
      res.status(201).json({ data: await createEquipmentOperatorAssignment(String(req.params.id), body) });
    }),
  );

  router.post(
    "/equipment/assets/:id/expenses",
    ...equipGuard,
    requirePermission("equipment.asset.write"),
    asyncHandler(async (req, res) => {
      const body = parse(equipmentExpenseBody, req.body);
      res.status(201).json({ data: await createEquipmentExpense(String(req.params.id), body) });
    }),
  );

  router.get(
    "/equipment/clients",
    ...equipGuard,
    requirePermission("equipment.asset.read"),
    asyncHandler(async (_req, res) => {
      res.json({ data: await listClientsAndProjects() });
    }),
  );

  router.post(
    "/equipment/clients",
    ...equipGuard,
    requirePermission("equipment.mobilization.write"),
    asyncHandler(async (req, res) => {
      const body = parse(clientProjectBody, req.body);
      res.status(201).json({ data: await createClientAndProject(body) });
    }),
  );
}
