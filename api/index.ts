import type { IncomingMessage, ServerResponse } from "node:http";
import type { Express } from "express";

let appPromise: Promise<Express> | null = null;
let dbPromise: Promise<void> | null = null;

function loadApp() {
  if (!appPromise) {
    appPromise = import("../src/app").then((mod) => mod.createApp()).catch((error: unknown) => {
      appPromise = null;
      throw error;
    });
  }
  return appPromise;
}

function loadDb() {
  if (!dbPromise) {
    dbPromise = import("../src/lib/db").then((mod) => mod.connectDb()).catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function publicMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Invalid environment configuration:")) return message;
  if (/mongo|ENOTFOUND|querySrv|ECONNREFUSED|authentication failed/i.test(message)) return "Could not connect to the database";
  return "The API could not start";
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await loadApp();
    const path = req.url?.split("?")[0] ?? "/";
    if (path !== "/" && path !== "/api/v1/health") await loadDb();
    await new Promise<void>((resolve, reject) => {
      res.once("finish", () => resolve());
      res.once("close", () => resolve());
      try {
        app(req, res);
      } catch (error) {
        reject(error);
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "startup failed";
    console.error(message.replace(/mongodb(\+srv)?:\/\/\S+/gi, "mongodb://[redacted]"));
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { code: "STARTUP", message: publicMessage(error) } }));
    }
  }
}
