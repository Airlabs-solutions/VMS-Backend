import type { Response } from "express";
import ExcelJS from "exceljs";

export type SortSpec = Record<string, 1 | -1>;

export type ListQuery = {
  page: number;
  limit: number;
  skip: number;
  q?: string;
  sort: SortSpec;
  filter: Record<string, string>;
};

export function parseSort(raw: string | undefined, allowed: string[], fallback: string): SortSpec {
  const value = raw && raw.length > 0 ? raw : fallback;
  const desc = value.startsWith("-");
  const field = desc ? value.slice(1) : value;
  if (!allowed.includes(field)) {
    const fallbackDesc = fallback.startsWith("-");
    const fallbackField = fallbackDesc ? fallback.slice(1) : fallback;
    return { [fallbackField]: fallbackDesc ? -1 : 1 };
  }
  return { [field]: desc ? -1 : 1 };
}

export function listArgs(
  query: { page?: number; limit?: number; sort?: string; q?: string; filter?: Record<string, string> },
  allowedSort: string[],
  fallbackSort: string,
): ListQuery {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  return {
    page,
    limit,
    skip: (page - 1) * limit,
    q: query.q?.trim() || undefined,
    sort: parseSort(query.sort, allowedSort, fallbackSort),
    filter: query.filter ?? {},
  };
}

export function listResult<T>(rows: T[], total: number, query: ListQuery) {
  return { data: rows, meta: { page: query.page, limit: query.limit, total } };
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type ExcelColumn = { header: string; key: string; width?: number };

export async function writeXlsx(res: Response, filename: string, columns: ExcelColumn[], rows: Record<string, unknown>[]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Export");
  sheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width ?? 18 }));
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

export async function readSheetRows(buffer: Buffer): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const headers: string[] = [];
  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) {
      row.eachCell((cell, col) => {
        headers[col] = String(cell.value ?? "").trim();
      });
      return;
    }
    const record: Record<string, string> = {};
    row.eachCell((cell, col) => {
      const header = headers[col];
      if (!header) return;
      const value = cell.value;
      if (value && typeof value === "object" && "text" in value) {
        record[header] = String((value as { text: string }).text ?? "").trim();
      } else if (value instanceof Date) {
        record[header] = value.toISOString();
      } else {
        record[header] = String(value ?? "").trim();
      }
    });
    if (Object.values(record).some((item) => item.length > 0)) rows.push(record);
  });
  return rows;
}

export async function workbookBuffer(columns: string[], sample: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Vehicles");
  sheet.addRow(columns);
  for (const line of sample) sheet.addRow(line);
  sheet.getRow(1).font = { bold: true };
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as unknown as Uint8Array);
}
