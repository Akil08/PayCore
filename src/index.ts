import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./db.js";
import { config } from "./config.js";
import { wrap } from "./http/wrap.js";
import { AppError } from "./http/errors.js";
import authRouter from "./routes/auth.js";
import { requireAuth } from "./http/auth.js";
import accountsRouter from "./routes/accounts.js";
import transfersRouter from "./routes/transfers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

app.get(
  "/health",
  wrap(async (_req, res) => {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      res.json({ ok: true, db: true });
    } finally {
      client.release();
    }
  }),
);

// === ROUTE MOUNTS START ===
app.use("/api/auth", authRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/transfers", transfersRouter);
// Later sessions will add routes here, e.g.:
// app.use('/api/accounts', accountsRouter);
// === ROUTE MOUNTS END ===











// Central error middleware
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof AppError) {
      res
        .status(err.status)
        .json({ error: { code: err.code, message: err.message } });
    } else {
      console.error("Unexpected error:", err);
      res.status(500).json({
        error: {
          code: "internal_error",
          message: "An unexpected error occurred",
        },
      });
    }
  },
);

app.listen(config.PORT, () => {
  console.log(`PayCore API listening on port ${config.PORT}`);
});

// === WORKERS START ===
// if (config.RUN_WORKERS) {
//   startAllWorkers(); // Will be implemented in Session 6
// }
// === WORKERS END ===












