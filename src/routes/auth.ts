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

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Register a new user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 example: User#12345
 *     responses:
 *       201:
 *         description: User registered successfully with starting deposit
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     email:
 *                       type: string
 *                     role:
 *                       type: string
 *                 account_id:
 *                   type: string
 *                   format: uuid
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Email already taken
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

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
      // what client means in this context ?  
      // In this context, "client" refers to a database client that is used to execute SQL 
      // queries within a transaction. The `withTx` function likely manages the transaction 
      // lifecycle, providing a client that can be used to perform multiple 
      // database operations atomically. If any operation fails, 
      // the transaction can be rolled back to maintain data integrity.
      // is appdbcontext of c# is similar to this client ?
      // Yes, the concept of a "client" in this context is somewhat similar to the `DbContext` 
      // in C#. 
      // Both serve as an abstraction for interacting with the database.
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

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Login user or analyst
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 example: User#12345
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     email:
 *                       type: string
 *                     role:
 *                       type: string
 *                 account_id:
 *                   type: string
 *                   format: uuid
 *                   nullable: true
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

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

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Logout user (stateless)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 */

router.post(
  "/logout",
  wrap(async (req: Request, res: Response) => {
    res.json({ ok: true });
  }),
);

export default router;
