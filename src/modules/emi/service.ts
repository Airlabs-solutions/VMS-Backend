import { z } from "zod";
import { formatDisplayDate, clampDueDay } from "../../lib/dates";
import { notFound } from "../../lib/errors";
import { formatSar, sarToHalalas } from "../../lib/money";
import { listArgs, listResult, writeXlsx } from "../../lib/pagination";
import { dateDto, moneyDto, statusDto } from "../../lib/present";
import { withTransaction } from "../../lib/tenantPlugin";
import { Vehicle } from "../vehicles/model";
import { EmiInstallment, EmiPlan } from "./model";

export const planBody = z.object({
  vehicleId: z.string().regex(/^[a-f\d]{24}$/i),
  bank: z.string().trim().min(1).max(120),
  loanAmount: z.coerce.number().min(0),
  downPayment: z.coerce.number().min(0),
  monthlyAmount: z.coerce.number().min(0),
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
  monthlyAmountHalalas: number;
  tenureMonths: number;
  startDate: Date;
  dueDay: number;
}) {
  const installments = await EmiInstallment.find({ emiPlanId: plan._id }).lean();
  const paid = installments.filter((item) => item.status === "paid");
  const paidHalalas = paid.reduce((sum, item) => sum + item.amountHalalas, 0);
  const remaining = installments.filter((item) => item.status === "unpaid").reduce((sum, item) => sum + item.amountHalalas, 0);
  const vehicle = await Vehicle.findById(plan.vehicleId).select("plateNumber").lean();
  return {
    id: String(plan._id),
    vehicleId: String(plan.vehicleId),
    plateNumber: vehicle?.plateNumber ?? "",
    bank: plan.bank,
    loanAmount: moneyDto(plan.loanAmountHalalas),
    downPayment: moneyDto(plan.downPaymentHalalas),
    monthlyAmount: moneyDto(plan.monthlyAmountHalalas),
    tenureMonths: plan.tenureMonths,
    startDate: dateDto(plan.startDate),
    dueDay: plan.dueDay,
    totalPaid: moneyDto(paidHalalas),
    remaining: moneyDto(remaining),
    installmentsLeft: installments.length - paid.length,
  };
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

export async function createPlan(input: z.infer<typeof planBody>) {
  const vehicle = await Vehicle.findById(input.vehicleId);
  if (!vehicle) throw notFound("Vehicle");
  const plan = await withTransaction(async (session) => {
    const created = await EmiPlan.create(
      [
        {
          vehicleId: vehicle._id,
          bank: input.bank,
          loanAmountHalalas: sarToHalalas(input.loanAmount),
          downPaymentHalalas: sarToHalalas(input.downPayment),
          monthlyAmountHalalas: sarToHalalas(input.monthlyAmount),
          tenureMonths: input.tenureMonths,
          startDate: input.startDate,
          dueDay: input.dueDay,
        },
      ],
      { session },
    );
    const planDoc = created[0];
    const start = new Date(input.startDate);
    const docs = [];
    for (let seq = 1; seq <= input.tenureMonths; seq += 1) {
      const monthIndex = start.getUTCMonth() + seq - 1;
      const year = start.getUTCFullYear() + Math.floor(monthIndex / 12);
      const month = ((monthIndex % 12) + 12) % 12;
      docs.push({
        emiPlanId: planDoc._id,
        vehicleId: vehicle._id,
        seq,
        dueDate: clampDueDay(year, month, input.dueDay),
        amountHalalas: sarToHalalas(input.monthlyAmount),
        status: "unpaid" as const,
      });
    }
    await EmiInstallment.create(docs, { session });
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
