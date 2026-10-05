import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "../config/constants";
import { env } from "../config/env";
import { asyncHandler } from "../lib/asyncHandler";
import { AppError } from "../lib/errors";
import { authenticate } from "../middleware/authenticate";
import { buildLimiter } from "../middleware/rateLimit";
import { requireRole } from "../middleware/requireRole";
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
import { createIstimara, exportIstimara, istimaraBody, listIstimara } from "../modules/istimara/service";
import { claimBody, createClaim, createPolicy, exportInsurance, listClaims, listPolicies, policyBody, updateClaimStatus } from "../modules/insurance/service";
import { createLog, createSchedule, exportMaintenance, listLogs, listSchedules, logBody, scheduleBody } from "../modules/maintenance/service";
import { myFuel, myMessages, myProfile, myReply, myTrip, myUnread, myVehicle, myViolations, updateMyProfile, uploadMyPhoto } from "../modules/me/service";
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
import { deleteDirectMessage, listDirectMessages, messageBody, sendDirectMessage, updateDirectMessage } from "../modules/messages/service";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

function details(error: z.ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Check the highlighted fields", details(parsed.error));
  return parsed.data;
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
    res.json({
      data: {
        id: String(user._id),
        name: user.name,
        email: user.email ?? null,
        role: user.role,
        companyId: req.ctx?.companyId ?? null,
        companyName: company?.name ?? null,
        driverId: req.ctx?.driverId ?? null,
        supportGrantId: req.ctx?.supportGrantId ?? null,
      },
    });
  }));

  router.get("/platform/companies", authenticate, requireRole("super_admin"), asyncHandler(async (_req, res) => {
    res.json({ data: await listCompanies() });
  }));
  router.post("/platform/companies", authenticate, requireRole("super_admin"), asyncHandler(async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(160),
      plan: z.string().trim().max(40).optional(),
      maxVehicles: z.coerce.number().int().min(1).max(500),
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
      plan: z.string().trim().max(40).optional(),
      maxVehicles: z.coerce.number().int().min(1).max(500).optional(),
      smsSenderName: z.string().trim().max(11).optional(),
      smsCredits: z.coerce.number().int().min(0).optional(),
      driverPasswordLogin: z.boolean().optional(),
    }), req.body);
    res.json({ data: await updateCompany(String(req.params.id), body) });
  }));
  router.get("/platform/support-grants", authenticate, requireRole("super_admin"), asyncHandler(async (_req, res) => {
    res.json({ data: await listSupportGrants() });
  }));
  router.post("/platform/support-grants/:id/enter", authenticate, requireRole("super_admin"), asyncHandler(async (req, res) => {
    res.json({ data: await enterSupportGrant(String(req.params.id), res) });
  }));

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

  router.get("/vehicles/export.xlsx", ...admin, asyncHandler(async (req, res) => {
    await exportVehicles(paging(req.query as Record<string, unknown>), res);
  }));
  router.get("/vehicles/import/template.xlsx", ...admin, asyncHandler(async (_req, res) => {
    const buffer = await importTemplate();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=\"vehicle-import-template.xlsx\"");
    res.send(buffer);
  }));
  router.get("/vehicles", ...admin, asyncHandler(async (req, res) => {
    res.json(await listVehicles(paging(req.query as Record<string, unknown>)));
  }));
  router.post("/vehicles", ...admin, asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createVehicle(parse(vehicleBody, req.body)) });
  }));
  router.post("/vehicles/import", ...admin, upload.single("file"), asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "INVALID_FILE", "Choose an Excel file");
    res.json({ data: await previewImport(req.file.buffer) });
  }));
  router.post("/vehicles/import/:id/commit", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await commitImport(String(req.params.id)) });
  }));
  router.get("/vehicles/:id", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await getVehicle(String(req.params.id)) });
  }));
  router.patch("/vehicles/:id", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await updateVehicle(String(req.params.id), parse(vehicleBody.partial(), req.body)) });
  }));
  router.delete("/vehicles/:id", ...admin, asyncHandler(async (req, res) => {
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
  router.get("/messages", ...admin, asyncHandler(async (_req, res) => {
    res.json({ data: await listDirectMessages() });
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
  router.get("/vehicles/:id/handovers", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await listHandovers(String(req.params.id)) });
  }));

  router.get("/maintenance/schedules", ...admin, asyncHandler(async (req, res) => {
    res.json(await listSchedules(paging(req.query as Record<string, unknown>)));
  }));
  router.post("/maintenance/schedules", ...admin, asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createSchedule(parse(scheduleBody, req.body)) });
  }));
  router.get("/maintenance/logs", ...admin, asyncHandler(async (req, res) => {
    res.json(await listLogs(paging(req.query as Record<string, unknown>)));
  }));
  router.post("/maintenance/logs", ...admin, asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createLog(parse(logBody, req.body)) });
  }));
  router.get("/maintenance/export.xlsx", ...admin, asyncHandler(async (_req, res) => exportMaintenance(res)));

  router.get("/istimara", ...admin, asyncHandler(async (req, res) => res.json(await listIstimara(paging(req.query as Record<string, unknown>)))));
  router.post("/istimara", ...admin, asyncHandler(async (req, res) => res.status(201).json({ data: await createIstimara(parse(istimaraBody, req.body)) })));
  router.get("/istimara/export.xlsx", ...admin, asyncHandler(async (_req, res) => exportIstimara(res)));

  router.get("/insurance/policies", ...admin, asyncHandler(async (req, res) => res.json(await listPolicies(paging(req.query as Record<string, unknown>)))));
  router.post("/insurance/policies", ...admin, asyncHandler(async (req, res) => res.status(201).json({ data: await createPolicy(parse(policyBody, req.body)) })));
  router.get("/insurance/claims", ...admin, asyncHandler(async (req, res) => res.json(await listClaims(paging(req.query as Record<string, unknown>)))));
  router.post("/insurance/claims", ...admin, asyncHandler(async (req, res) => res.status(201).json({ data: await createClaim(parse(claimBody, req.body)) })));
  router.patch("/insurance/claims/:id", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({ status: z.enum(["submitted", "approved", "rejected", "paid"]) }), req.body);
    res.json({ data: await updateClaimStatus(String(req.params.id), body.status) });
  }));
  router.get("/insurance/export.xlsx", ...admin, asyncHandler(async (_req, res) => exportInsurance(res)));

  router.get("/emi/plans", ...admin, asyncHandler(async (req, res) => res.json(await listPlans(paging(req.query as Record<string, unknown>)))));
  router.post("/emi/plans", ...admin, asyncHandler(async (req, res) => res.status(201).json({ data: await createPlan(parse(planBody, req.body)) })));
  router.get("/emi/plans/:id/installments", ...admin, asyncHandler(async (req, res) => res.json({ data: await listInstallments(String(req.params.id)) })));
  router.patch("/emi/installments/:id", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({ status: z.enum(["paid", "unpaid"]), paidDate: z.coerce.date().optional() }), req.body);
    res.json({ data: await markInstallment(String(req.params.id), body.status, body.paidDate) });
  }));
  router.get("/emi/export.xlsx", ...admin, asyncHandler(async (_req, res) => exportEmi(res)));

  router.get("/fuel", ...admin, asyncHandler(async (req, res) => res.json(await listFuel(paging(req.query as Record<string, unknown>)))));
  router.post("/fuel", ...admin, asyncHandler(async (req, res) => res.status(201).json({ data: await createFuel(parse(fuelBody, req.body)) })));
  router.patch("/fuel/:id", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({ approvalStatus: z.enum(["approved", "rejected"]) }), req.body);
    res.json({ data: await setFuelApproval(String(req.params.id), body.approvalStatus) });
  }));
  router.get("/fuel/export.xlsx", ...admin, asyncHandler(async (_req, res) => exportRows(res, "fuel")));

  router.get("/violations", ...admin, asyncHandler(async (req, res) => res.json(await listViolations(paging(req.query as Record<string, unknown>)))));
  router.post("/violations", ...admin, asyncHandler(async (req, res) => res.status(201).json({ data: await createViolation(parse(violationBody, req.body)) })));
  router.patch("/violations/:id", ...admin, asyncHandler(async (req, res) => {
    const body = parse(z.object({ status: z.enum(["unpaid", "paid", "disputed"]).optional(), deductFromDriver: z.boolean().optional() }), req.body);
    res.json({ data: await updateViolation(String(req.params.id), body) });
  }));
  router.get("/violations/export.xlsx", ...admin, asyncHandler(async (_req, res) => exportRows(res, "violations")));

  router.get("/trips", ...admin, asyncHandler(async (req, res) => res.json(await listTrips(paging(req.query as Record<string, unknown>)))));
  router.post("/trips", ...admin, asyncHandler(async (req, res) => res.status(201).json({ data: await createTrip(parse(tripBody, req.body)) })));
  router.get("/trips/export.xlsx", ...admin, asyncHandler(async (_req, res) => exportRows(res, "trips")));

  router.get("/expenses", ...admin, asyncHandler(async (req, res) => res.json(await listExpenses(paging(req.query as Record<string, unknown>)))));
  router.post("/expenses", ...admin, asyncHandler(async (req, res) => res.status(201).json({ data: await createExpense(parse(expenseBody, req.body)) })));
  router.get("/expenses/export.xlsx", ...admin, asyncHandler(async (_req, res) => exportRows(res, "expenses")));

  router.post("/files", ...admin, upload.single("file"), asyncHandler(async (req, res) => {
    const moduleName = String(req.body?.module ?? "documents").replace(/[^\w-]/g, "").slice(0, 40) || "documents";
    res.status(201).json({ data: await saveUpload(req.file, moduleName) });
  }));
  router.get("/files/:id/url", ...admin, asyncHandler(async (req, res) => {
    res.json({ data: await signedUrl(String(req.params.id)) });
  }));
  router.get("/files/:id/download", asyncHandler(async (req, res) => {
    const token = req.query.token ? String(req.query.token) : undefined;
    if (!tokenIsValid(String(req.params.id), token)) throw new AppError(403, "FORBIDDEN", "This download link is invalid or expired");
    await streamFile(String(req.params.id), res);
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

  router.get("/reports/:name/export.xlsx", ...admin, asyncHandler(async (req, res) => {
    await runReport(String(req.params.name), paging(req.query as Record<string, unknown>), res);
  }));
  router.get("/reports/:name", ...admin, asyncHandler(async (req, res) => {
    res.json(await runReport(String(req.params.name), paging(req.query as Record<string, unknown>)));
  }));

  router.get("/me/profile", authenticate, requireRole("driver"), asyncHandler(async (_req, res) => {
    res.json({ data: await myProfile() });
  }));
  router.patch("/me/profile", authenticate, requireRole("driver"), asyncHandler(async (req, res) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(120).optional(),
      mobile: z.string().trim().min(7).max(24).optional(),
    }), req.body);
    res.json({ data: await updateMyProfile(body) });
  }));
  router.post("/me/photo", authenticate, requireRole("driver"), upload.single("file"), asyncHandler(async (req, res) => {
    res.json({ data: await uploadMyPhoto(req.file) });
  }));
  router.get("/me/messages/unread", authenticate, requireRole("driver"), asyncHandler(async (_req, res) => {
    res.json({ data: await myUnread() });
  }));
  router.get("/me/messages", authenticate, requireRole("driver"), asyncHandler(async (_req, res) => {
    res.json({ data: await myMessages() });
  }));
  router.post("/me/messages", authenticate, requireRole("driver"), asyncHandler(async (req, res) => {
    const body = parse(z.object({ body: z.string().trim().min(1).max(500) }), req.body);
    res.status(201).json({ data: await myReply(body.body) });
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
}
