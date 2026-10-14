import { z } from "zod";
import { clampDueDay, daysBetween, formatDisplayDate, riyadhDateKey } from "../../lib/dates";
import { AppError, notFound } from "../../lib/errors";
import { formatSar, sarToHalalas } from "../../lib/money";
import { listArgs, listResult, writeXlsx } from "../../lib/pagination";
import { dateDto, moneyDto, statusDto } from "../../lib/present";
import { withTransaction } from "../../lib/tenantPlugin";
import { Vehicle } from "../vehicles/model";
import { EmiInstallment, EmiPlan } from "./model";

export const planBody = z.object({
  vehicleId: z.string().regex(/^[a-f\d]{24}$/i),
  bank: z.string().trim().min(1).max(120),
  loanAmount: z.coerce.number().positive(),
  downPayment: z.coerce.number().min(0).default(0),
  interestRate: z.coerce.number().min(0).max(100).default(0),
  tenureMonths: z.coerce.number().int().min(1).max(120),
  startDate: z.coerce.date(),
  dueDay: z.coerce.number().int().min(1).max(28),
});

async function planSummary(plan: {
  _id: unknown;
  vehicleId: unknown;
  bank: string;
  loanAmountHalalas: number;
  downPaymentHalalas: number;
  interestRate?: number;
  monthlyAmountHalalas: number;
  tenureMonths: number;
  startDate: Date;
  dueDay: number;
}) {
  const installments = await EmiInstallment.find({ emiPlanId: plan._id }).lean();
  const paid = installments.filter((item) => item.status === "paid");
  const unpaid = installments
    .filter((item) => item.status !== "paid")
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  const paidHalalas = paid.reduce((sum, item) => sum + item.amountHalalas, 0);
  const remaining = unpaid.reduce((sum, item) => sum + item.amountHalalas, 0);
  const next = unpaid[0];
  const days = next ? daysBetween(new Date(), new Date(next.dueDate)) : null;
  const status = days == null ? "ok" : days < 0 ? "overdue" : days <= 3 ? "due_soon" : "ok";
  const vehicle = await Vehicle.findById(plan.vehicleId).select("plateNumber").lean();
  return {
    id: String(plan._id),
    vehicleId: String(plan.vehicleId),
    plateNumber: vehicle?.plateNumber ?? "",
    bank: plan.bank,
    loanAmount: moneyDto(plan.loanAmountHalalas),
    downPayment: moneyDto(plan.downPaymentHalalas),
    financed: moneyDto(Math.max(0, plan.loanAmountHalalas - plan.downPaymentHalalas)),
    interestRate: plan.interestRate ?? 0,
    monthlyAmount: moneyDto(plan.monthlyAmountHalalas),
    tenureMonths: plan.tenureMonths,
    startDate: dateDto(plan.startDate),
    dueDay: plan.dueDay,
    nextDue: dateDto(next?.dueDate),
    totalPaid: moneyDto(paidHalalas),
    remaining: moneyDto(remaining),
    installmentsLeft: unpaid.length,
    status: statusDto(status),
  };
}

function installmentAmounts(principalHalalas: number, annualPercent: number, months: number) {
  if (principalHalalas <= 0) throw new AppError(400, "VALIDATION_ERROR", "Down payment must be less than the loan amount");
  if (annualPercent <= 0) {
    const base = Math.floor(principalHalalas / months);
    const amounts = Array.from({ length: months }, () => base);
    amounts[months - 1] = principalHalalas - base * (months - 1);
    return amounts;
  }
  const monthlyRate = annualPercent / 100 / 12;
  const factor = (1 + monthlyRate) ** months;
  const monthly = Math.round((principalHalalas * monthlyRate * factor) / (factor - 1));
  if (monthly <= 0) throw new AppError(400, "VALIDATION_ERROR", "Check the loan amount, interest, and tenure");
  return Array.from({ length: months }, () => monthly);
}

function scheduleDates(start: Date, dueDay: number, count: number) {
  const [yearText, monthText, dayText] = riyadhDateKey(start).split("-");
  let year = Number(yearText);
  let monthIndex = Number(monthText) - 1;
  if (Number(dayText) > dueDay) {
    monthIndex += 1;
    if (monthIndex > 11) {
      monthIndex = 0;
      year += 1;
    }
  }
  return Array.from({ length: count }, (_, index) => {
    const cursor = monthIndex + index;
    return clampDueDay(year + Math.floor(cursor / 12), cursor % 12, dueDay);
  });
}

export async function listPlans(raw: { page?: number; limit?: number; vehicleId?: string }) {
  const query = listArgs(raw, ["startDate", "bank"], "-startDate");
  const filter: Record<string, unknown> = {};
  if (raw.vehicleId) filter.vehicleId = raw.vehicleId;
  const [rows, total] = await Promise.all([
    EmiPlan.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    EmiPlan.countDocuments(filter),
  ]);
  return listResult(await Promise.all(rows.map((row) => planSummary(row))), total, query);
}

export async function createPlan(input: {
  vehicleId: string;
  bank: string;
  loanAmount: number;
  downPayment?: number;
  interestRate?: number;
  tenureMonths: number;
  startDate: Date;
  dueDay: number;
}) {
  const vehicle = await Vehicle.findById(input.vehicleId);
  if (!vehicle) throw notFound("Vehicle");
  const interestRate = input.interestRate ?? 0;
  const downPayment = input.downPayment ?? 0;
  const loanHalalas = sarToHalalas(input.loanAmount);
  const downHalalas = sarToHalalas(downPayment);
  const amounts = installmentAmounts(loanHalalas - downHalalas, interestRate, input.tenureMonths);
  const dates = scheduleDates(input.startDate, input.dueDay, input.tenureMonths);
  const plan = await withTransaction(async (session) => {
    const paid = await EmiInstallment.countDocuments({ vehicleId: vehicle._id, status: "paid" }).session(session);
    if (paid > 0) throw new AppError(409, "EMI_EXISTS", "This vehicle already has EMI payments, so the schedule was not replaced");
    await EmiInstallment.deleteMany({ vehicleId: vehicle._id }).session(session);
    await EmiPlan.deleteMany({ vehicleId: vehicle._id }).session(session);
    const created = await EmiPlan.create(
      [
        {
          vehicleId: vehicle._id,
          bank: input.bank,
          loanAmountHalalas: loanHalalas,
          downPaymentHalalas: downHalalas,
          interestRate,
          monthlyAmountHalalas: amounts[0],
          tenureMonths: input.tenureMonths,
          startDate: input.startDate,
          dueDay: input.dueDay,
        },
      ],
      { session, ordered: true },
    );
    const planDoc = created[0];
    await EmiInstallment.create(
      amounts.map((amountHalalas, index) => ({
        emiPlanId: planDoc._id,
        vehicleId: vehicle._id,
        seq: index + 1,
        dueDate: dates[index],
        amountHalalas,
        status: "unpaid" as const,
      })),
      { session, ordered: true },
    );
    return planDoc;
  });
  return planSummary(plan.toObject());
}

export async function listInstallments(planId: string) {
  const rows = await EmiInstallment.find({ emiPlanId: planId }).sort({ seq: 1 }).lean();
  return rows.map((row) => ({
    id: String(row._id),
    seq: row.seq,
    dueDate: dateDto(row.dueDate),
    amount: moneyDto(row.amountHalalas),
    status: statusDto(row.status),
    paidDate: dateDto(row.paidDate),
    vehicleId: String(row.vehicleId),
  }));
}

export async function markInstallment(id: string, status: "paid" | "unpaid", paidDate?: Date) {
  const row = await EmiInstallment.findById(id);
  if (!row) throw notFound("Installment");
  row.status = status;
  row.paidDate = status === "paid" ? paidDate ?? new Date() : undefined;
  await row.save();
  return { id: String(row._id), status: statusDto(row.status), paidDate: dateDto(row.paidDate) };
}

export async function exportEmi(res: import("express").Response) {
  const rows = await EmiInstallment.find().sort({ dueDate: 1 }).limit(10000).lean();
  const vehicles = await Vehicle.find({ _id: { $in: rows.map((row) => row.vehicleId) } }).select("plateNumber").lean();
  const plates = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.plateNumber]));
  await writeXlsx(
    res,
    "emi.xlsx",
    [
      { header: "Plate", key: "plate" },
      { header: "Installment", key: "seq" },
      { header: "Due date", key: "dueDate" },
      { header: "Amount", key: "amount" },
      { header: "Status", key: "status" },
      { header: "Paid date", key: "paidDate" },
    ],
    rows.map((row) => ({
      plate: plates.get(String(row.vehicleId)) ?? "",
      seq: row.seq,
      dueDate: formatDisplayDate(row.dueDate),
      amount: formatSar(row.amountHalalas),
      status: statusDto(row.status).label,
      paidDate: formatDisplayDate(row.paidDate),
    })),
  );
}
