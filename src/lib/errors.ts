export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFound(entity = "Record"): AppError {
  return new AppError(404, "NOT_FOUND", `${entity} was not found`);
}
