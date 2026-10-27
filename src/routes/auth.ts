import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { wrap } from "../http/wrap.js";
import { AppError } from "../http/errors.js";
import { withTx, pool } from "../db.js";
import { moveMoney } from "../services/ledger.js";
import { config, EXTERNAL_BANK_ID } from "../config.js";
import { UserPayload } from "../http/auth.js";

const router = Router();

router.post(
  "/register",
  wrap(async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (typeof email !== "string" || typeof password !== "string") {
      throw new AppError(
        400,
        "invalid_request",
        "Email and password are required",
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError(400, "invalid_email", "Invalid email format");
    }
    if (password.length < 8) {
      throw new AppError(
        400,
        "invalid_password",
        "Password must be at least 8 characters",
      );
    }

    const lowerEmail = email.toLowerCase();
    const passwordHash = await bcrypt.hash(password, 10);

    let userId!: string;
    let accountId!: string;

    try {
      await withTx(async (client) => {
        // 1. Create user
        const userRes = await client.query(
          "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
          [lowerEmail, passwordHash, "user"],
        );
        userId = userRes.rows[0].id;

        // 2. Create user account
        const accountRes = await client.query(
          "INSERT INTO accounts (user_id, type, balance, status) VALUES ($1, $2, $3, $4) RETURNING id",
          [userId, "user", 0, "active"],
        );
        accountId = accountRes.rows[0].id;

        // 3. Starting deposit (1,000,000 paisa = 10,000 BDT)
        await moveMoney(client, {
          fromAccountId: EXTERNAL_BANK_ID,
          toAccountId: accountId,
          amount: 1000000,
          transferId: null,
          reason: "deposit",
        });
      });
    } catch (err: any) {
      // Postgres unique violation code
      if (err.code === "23505") {
        throw new AppError(409, "email_taken", "Email is already registered");
      }
      throw err;
    }

    // hwo to assign user and accoutn id ?
    // Create JWT token
    // Create JWT token 
    // 

    const payload: UserPayload = { userId, accountId, role: "user" };
    const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: "8h" });

    res.status(201).json({
      token,
      user: { id: userId, email: lowerEmail, role: "user" },
      account_id: accountId,
    });
  }),
);

router.post(
  "/login",
  wrap(async (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (typeof email !== "string" || typeof password !== "string") {
      throw new AppError(
        400,
        "invalid_request",
        "Email and password are required",
      );
    }

    const lowerEmail = email.toLowerCase();
    const userRes = await pool.query(
      "SELECT id, password_hash, role FROM users WHERE email = $1",
      [lowerEmail],
    );

    if (userRes.rows.length === 0) {
      throw new AppError(
        401,
        "invalid_credentials",
        "Invalid email or password",
      );
    }

    const user = userRes.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      throw new AppError(
        401,
        "invalid_credentials",
        "Invalid email or password",
      );
    }

    let accountId: string | null = null;
    if (user.role === "user") {
      const accountRes = await pool.query(
        "SELECT id FROM accounts WHERE user_id = $1 AND type = $2",
        [user.id, "user"],
      );
      if (accountRes.rows.length > 0) {
        accountId = accountRes.rows[0].id;
      }
    }

    const payload: UserPayload = {
      userId: user.id,
      accountId,
      role: user.role,
    };
    const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: "8h" });

    res.json({
      token,
      user: { id: user.id, email: lowerEmail, role: user.role },
      account_id: accountId,
    });
  }),
);

router.post(
  "/logout",
  wrap(async (req: Request, res: Response) => {
    res.json({ ok: true });
  }),
);

export default router;
