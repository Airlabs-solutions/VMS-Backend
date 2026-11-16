import { Types } from "mongoose";
import { z } from "zod";
import { AppError, notFound } from "../../lib/errors";
import { CustomFieldDefinition } from "./model";

export const customFieldBody = z.object({
  target: z.enum(["vehicle", "equipment", "employee"]),
  key: z.string().trim().min(1).max(40).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Key must be alphanumeric"),
  label: z.string().trim().min(1).max(80),
  type: z.enum(["text", "number", "date", "dropdown"]),
  options: z.array(z.string().trim().min(1)).optional(),
  required: z.boolean().optional(),
});

export type CustomFieldInput = z.infer<typeof customFieldBody>;

export async function listCustomFields(target?: "vehicle" | "equipment" | "employee") {
  const filter = target ? { target } : {};
  const rows = await CustomFieldDefinition.find(filter).sort({ target: 1, label: 1 }).lean();
  return rows.map((r) => ({
    id: String(r._id),
    target: r.target,
    key: r.key,
    label: r.label,
    type: r.type,
    options: r.options ?? [],
    required: r.required,
  }));
}

export async function createCustomField(input: CustomFieldInput) {
  if (input.type === "dropdown" && (!input.options || input.options.length === 0)) {
    throw new AppError(400, "VALIDATION_ERROR", "Dropdown custom fields require at least one option");
  }

  const existing = await CustomFieldDefinition.findOne({ target: input.target, key: input.key });
  if (existing) {
    throw new AppError(409, "DUPLICATE", `Field key "${input.key}" already exists for ${input.target}`);
  }

  const created = await CustomFieldDefinition.create({
    target: input.target,
    key: input.key,
    label: input.label,
    type: input.type,
    options: input.options ?? [],
    required: input.required ?? false,
  });

  return {
    id: String(created._id),
    target: created.target,
    key: created.key,
    label: created.label,
    type: created.type,
    options: created.options,
    required: created.required,
  };
}

export async function deleteCustomField(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "VALIDATION_ERROR", "Invalid field ID");
  const field = await CustomFieldDefinition.findByIdAndDelete(id);
  if (!field) throw notFound("CustomFieldDefinition");
  return { ok: true };
}

export async function validateCustomValues(
  target: "vehicle" | "equipment" | "employee",
  values: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const definitions = await CustomFieldDefinition.find({ target }).lean();
  const sanitized: Record<string, unknown> = {};

  for (const def of definitions) {
    const val = values[def.key];
    if (def.required && (val === undefined || val === null || val === "")) {
      throw new AppError(400, "VALIDATION_ERROR", `${def.label} is required`);
    }

    if (val !== undefined && val !== null && val !== "") {
      if (def.type === "number") {
        const num = Number(val);
        if (Number.isNaN(num)) throw new AppError(400, "VALIDATION_ERROR", `${def.label} must be a number`);
        sanitized[def.key] = num;
      } else if (def.type === "date") {
        const date = new Date(val as string);
        if (Number.isNaN(date.getTime())) throw new AppError(400, "VALIDATION_ERROR", `${def.label} must be a valid date`);
        sanitized[def.key] = date;
      } else if (def.type === "dropdown") {
        if (!def.options?.includes(String(val))) {
          throw new AppError(400, "VALIDATION_ERROR", `${def.label} must be one of the defined options`);
        }
        sanitized[def.key] = String(val);
      } else {
        sanitized[def.key] = String(val).slice(0, 500);
      }
    }
  }

  return sanitized;
}
