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
  emiAmount: z.coerce.number().positive(),
  balloonAmount: z.coerce.number().min(0).default(0),
  interestRate: z.coerce.number().min(0).max(100).default(0),
  tenureMonths: z.coerce.number().int().min(1).max(120),
  startDate: z.coerce.date(),
  dueDay: z.coerce.number().int().min(1).max(28),
});

async function planSummary(plan: {
  _id: unknown;
  vehicleId: unknown;
  bank: string;
  loanAmountHalalas?: number;
  balloonAmountHalalas?: number;
  interestRate?: number;
  monthlyAmountHalalas: number;
  tenureMonths: number;
  startDate: Date;
  dueDay: number;
}) {
  const installments = await EmiInstallment.find({ emiPlanId: plan._id }).lean();
  const paid = installments
    .filter((item) => item.status === "paid")
    .sort((a, b) => new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime());
  const unpaid = installments
    .filter((item) => item.status !== "paid")
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  const paidHalalas = paid.reduce((sum, item) => sum + item.amountHalalas, 0);
  const remaining = unpaid.reduce((sum, item) => sum + item.amountHalalas, 0);
  const next = unpaid[0];
  const days = next ? daysBetween(new Date(), new Date(next.dueDate)) : null;
  const status = days == null ? "ok" : days < 0 ? "overdue" : days <= 3 ? "due_soon" : "ok";
  const vehicle = await Vehicle.findById(plan.vehicleId).select("plateNumber name").lean();
  return {
    id: String(plan._id),
    vehicleId: String(plan.vehicleId),
    vehicleName: vehicle?.name?.trim() ?? "",
    plateNumber: vehicle?.plateNumber ?? "",
    bank: plan.bank,
    interestRate: plan.interestRate ?? 0,
    monthlyAmount: moneyDto(plan.monthlyAmountHalalas),
    balloonAmount: moneyDto(plan.balloonAmountHalalas ?? 0),
    tenureMonths: plan.tenureMonths,
    installmentCount: installments.length,
    startDate: dateDto(plan.startDate),
    dueDay: plan.dueDay,
    nextDue: dateDto(next?.dueDate),
    nextInstallmentId: next ? String(next._id) : null,
    lastPaidInstallmentId: paid[0] ? String(paid[0]._id) : null,
    totalPaid: moneyDto(paidHalalas),
    remaining: moneyDto(remaining),
    installmentsLeft: unpaid.length,
    status: statusDto(status),
  };
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
  emiAmount: number;
  balloonAmount?: number;
  interestRate?: number;
  tenureMonths: number;
  startDate: Date;
  dueDay: number;
}) {
  const vehicle = await Vehicle.findById(input.vehicleId);
  if (!vehicle) throw notFound("Vehicle");
  const interestRate = input.interestRate ?? 0;
  const monthlyHalalas = sarToHalalas(input.emiAmount);
  const balloonHalalas = sarToHalalas(input.balloonAmount ?? 0);
  if (monthlyHalalas <= 0) throw new AppError(400, "VALIDATION_ERROR", "Enter an EMI amount above zero");
  const amounts = Array.from({ length: input.tenureMonths }, () => monthlyHalalas);
  if (balloonHalalas > 0) amounts.push(balloonHalalas);
  const dates = scheduleDates(input.startDate, input.dueDay, amounts.length);
  const todayKey = riyadhDateKey(new Date());
  const plan = await withTransaction(async (session) => {
    await EmiInstallment.deleteMany({ vehicleId: vehicle._id }).session(session);
    await EmiPlan.deleteMany({ vehicleId: vehicle._id }).session(session);
    const created = await EmiPlan.create(
      [
        {
          vehicleId: vehicle._id,
          bank: input.bank,
          loanAmountHalalas: 0,
          downPaymentHalalas: 0,
          balloonAmountHalalas: balloonHalalas,
          interestRate,
          monthlyAmountHalalas: monthlyHalalas,
          tenureMonths: input.tenureMonths,
          startDate: input.startDate,
          dueDay: input.dueDay,
        },
      ],
      { session, ordered: true },
    );
    const planDoc = created[0];
    await EmiInstallment.create(
      amounts.map((amountHalalas, index) => {
        const dueDate = dates[index];
        const isPaid = riyadhDateKey(dueDate) <= todayKey;
        return {
          emiPlanId: planDoc._id,
          vehicleId: vehicle._id,
          seq: index + 1,
          dueDate,
          amountHalalas,
          status: isPaid ? ("paid" as const) : ("unpaid" as const),
          paidDate: isPaid ? dueDate : undefined,
        };
      }),
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
  const vehicles = await Vehicle.find({ _id: { $in: rows.map((row) => row.vehicleId) } }).select("plateNumber name").lean();
  const plates = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.plateNumber]));
  const names = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle.name?.trim() ?? ""]));
  await writeXlsx(
    res,
    "emi.xlsx",
    [
      { header: "Vehicle", key: "vehicle" },
      { header: "Plate", key: "plate" },
      { header: "Installment", key: "seq" },
      { header: "Due date", key: "dueDate" },
      { header: "Amount", key: "amount" },
      { header: "Status", key: "status" },
      { header: "Paid date", key: "paidDate" },
    ],
    rows.map((row) => ({
      vehicle: names.get(String(row.vehicleId)) ?? "",
      plate: plates.get(String(row.vehicleId)) ?? "",
      seq: row.seq,
      dueDate: formatDisplayDate(row.dueDate),
      amount: formatSar(row.amountHalalas),
      status: statusDto(row.status).label,
      paidDate: formatDisplayDate(row.paidDate),
    })),
  );
}
