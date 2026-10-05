import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { requestContext } from "./lib/context";
import { logger, redactMessage } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { sanitize } from "./middleware/sanitize";
import { mountRoutes } from "./routes";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(sanitize);
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
    });
    requestContext.run({ ip: req.ip }, () => next());
  });

  app.get("/api/v1/health", (_req, res) => {
    res.json({ data: { status: "ok" } });
  });
  app.get("/api/docs/openapi.json", (_req, res) => {
    res.json({
      openapi: "3.0.3",
      info: { title: "VMS API", version: "1.0.0" },
      servers: [{ url: "/api/v1" }],
      paths: {
        "/auth/login": { post: { summary: "Company admin login" } },
        "/auth/super-admin/google": { post: { summary: "Start super admin Google sign-in and email a code" } },
        "/auth/super-admin/verify": { post: { summary: "Verify the super admin Gmail code" } },
        "/auth/otp/request": { post: { summary: "Request a driver OTP" } },
        "/vehicles": { get: { summary: "List vehicles" }, post: { summary: "Create a vehicle" } },
        "/me/vehicle": { get: { summary: "Driver vehicle view" } },
      },
    });
  });

  const api = express.Router();
  mountRoutes(api);
  app.use("/api/v1", api);
  app.use(notFoundHandler);
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.too.large") {
      res.status(400).json({ error: { code: "INVALID_FILE", message: "Upload a PDF, JPG or PNG up to 10 MB" } });
      return;
    }
    if (err instanceof Error && err.message) {
      logger.error({ path: req.path, message: redactMessage(err.message) });
    }
    errorHandler(err, req, res, next);
  });
  return app;
}
