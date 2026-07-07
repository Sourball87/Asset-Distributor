import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";

if (!process.env.SESSION_SECRET) {
  process.stderr.write("FATAL: SESSION_SECRET env var is not set — refusing to start\n");
  process.exit(1);
}

const app: Express = express();

app.set("trust proxy", 1);

// CORS: build an explicit origin allowlist from env vars so we never reflect
// arbitrary origins back to the browser.
const rawOrigins = [
  ...(process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) ?? []),
  ...(process.env.REPLIT_DEV_DOMAIN ? [`https://${process.env.REPLIT_DEV_DOMAIN}`] : []),
  ...(process.env.REPLIT_DOMAINS?.split(",").map((d) => `https://${d.trim()}`).filter(Boolean) ?? []),
];
const allowedOrigins = new Set(rawOrigins);

app.use(
  cors({
    origin: (origin, callback) => {
      // No origin = same-origin / non-browser request (curl, server-to-server) — allow
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      callback(null, false);
    },
    credentials: true,
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

const PgSession = connectPgSimple(session);

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      // Replit always serves over HTTPS via proxy — secure+none required for iframe embedding
      secure: true,
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "none",
    },
  }),
);

app.use("/api", router);

export default app;
