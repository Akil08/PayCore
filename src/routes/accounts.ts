import { Router, Request, Response } from "express";
import { wrap } from "../http/wrap.js";
import { requireAuth } from "../http/auth.js";
import { AppError, InsufficientFundsError } from "../http/errors.js";
import { withTx } from "../db.js";
import { moveMoney } from "../services/ledger.js";
import { EXTERNAL_BANK_ID } from "../config.js";
import { getAccountById, getAccountByEmail } from "../services/accounts.js";
import {pool} from "../db.js";

const router = Router();

/**
 * @openapi
 * /accounts/me:
 *   get:
 *     tags:
 *       - Accounts
 *     summary: Get current user's account details
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Account details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 account_id:
 *                   type: string
 *                   format: uuid
 *                 email:
 *                   type: string
 *                 balance:
 *                   type: integer
 *                   description: Balance in paisa
 *                 status:
 *                   type: string
 *                   enum: [active, frozen, blacklisted]
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Account not found (e.g., analyst)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

router.get(
  "/me",
  requireAuth,
  wrap(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const accountId = user?.accountId;
    if (!accountId) {
      throw new AppError(404, "no_account", "Analyst has no account");
    }
    const account = await getAccountById(accountId);
    if (!account) {
      throw new AppError(404, "not_found", "Account not found");
    }
    res.json({
      account_id: account.id,
      email: account.email,
      balance: account.balance,
      status: account.status,
    });
  }),
);

/**
 * @openapi
 * /accounts/lookup:
 *   get:
 *     tags:
 *       - Accounts
 *     summary: Lookup account ID by email
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *           format: email
 *         description: Email address to lookup
 *     responses:
 *       200:
 *         description: Account found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 account_id:
 *                   type: string
 *                   format: uuid
 *                 email:
 *                   type: string
 *       400:
 *         description: Missing email parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Account not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

router.get(
  "/lookup",
  requireAuth,
  wrap(async (req: Request, res: Response) => {
    const email = (req.query.email as string)?.toLowerCase();
    if (!email) {
      throw new AppError(
        400,
        "missing_email",
        "Email query parameter is required",
      );
    }
    const account = await getAccountByEmail(email);
    if (!account) {
      throw new AppError(404, "not_found", "Account not found");
    }
    res.json({
      account_id: account.id,
      email: account.email,
    });
  }),
);


/**
 * @openapi
 * /accounts/deposit:
 *   post:
 *     tags:
 *       - Accounts
 *     summary: Deposit money into wallet
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: integer
 *                 description: Amount in paisa (min 1000, max 10000000)
 *                 example: 100000
 *     responses:
 *       200:
 *         description: Deposit successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 balance:
 *                   type: integer
 *                   description: New balance in paisa
 *       400:
 *         description: Invalid amount
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Account is not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

router.post(
  "/deposit",
  requireAuth,
  wrap(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const accountId = user?.accountId;
    if (!accountId) {
      throw new AppError(404, "no_account", "Analyst has no account");
    }
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount < 1000 || amount > 10000000) {
      throw new AppError(
        400,
        "invalid_amount",
        "Amount must be an integer between 1000 and 10000000",
      );
    }

    await withTx(async (client) => {
      const accRes = await client.query(
        `SELECT status FROM accounts WHERE id = $1`,
        [accountId],
      );
      if (!accRes.rows[0] || accRes.rows[0].status !== "active") {
        throw new AppError(403, "account_not_active", "Account is not active");
      }

      await moveMoney(client, {
        fromAccountId: EXTERNAL_BANK_ID,
        toAccountId: accountId,
        amount,
        transferId: null,
        reason: "deposit",
      });
    });

    const updatedAccount = await getAccountById(accountId);
    res.json({ balance: updatedAccount.balance });
  }),
);

/**
 * @openapi
 * /accounts/withdraw:
 *   post:
 *     tags:
 *       - Accounts
 *     summary: Withdraw money from wallet
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: integer
 *                 description: Amount in paisa (min 1000, max 10000000)
 *                 example: 50000
 *     responses:
 *       200:
 *         description: Withdrawal successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 balance:
 *                   type: integer
 *                   description: New balance in paisa
 *       400:
 *         description: Invalid amount or insufficient balance
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Account is not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

router.post(
  "/withdraw",
  requireAuth,
  wrap(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const accountId = user?.accountId;
    if (!accountId) {
      throw new AppError(404, "no_account", "Analyst has no account");
    }
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount < 1000 || amount > 10000000) {
      throw new AppError(
        400,
        "invalid_amount",
        "Amount must be an integer between 1000 and 10000000",
      );
    }

    try {
      await withTx(async (client) => {
        const accRes = await client.query(
          `SELECT status FROM accounts WHERE id = $1`,
          [accountId],
        );
        if (!accRes.rows[0] || accRes.rows[0].status !== "active") {
          throw new AppError(
            403,
            "account_not_active",
            "Account is not active",
          );
        }

        await moveMoney(client, {
          fromAccountId: accountId,
          toAccountId: EXTERNAL_BANK_ID,
          amount,
          transferId: null,
          reason: "withdrawal",
        });
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof InsufficientFundsError) {
        throw new AppError(400, "insufficient_balance", "Insufficient balance");
      }
      throw err;
    }

    const updatedAccount = await getAccountById(accountId);
    res.json({ balance: updatedAccount.balance });
  }),
);

/**
 * @openapi
 * /accounts/me/history:
 *   get:
 *     tags:
 *       - Accounts
 *     summary: Get ledger history for current account
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number (1-based)
 *     responses:
 *       200:
 *         description: Ledger history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       amount:
 *                         type: integer
 *                       reason:
 *                         type: string
 *                       transfer_id:
 *                         type: string
 *                         format: uuid
 *                         nullable: true
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                 page:
 *                   type: integer
 *                 has_more:
 *                   type: boolean
 *       400:
 *         description: Invalid page number
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

router.get(
  "/me/history",
  requireAuth,
  wrap(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const accountId = user?.accountId;
    if (!accountId) {
      throw new AppError(404, "no_account", "Analyst has no account");
    }
    const page = parseInt(String(req.query.page || "1"), 10);
    if (isNaN(page) || page < 1) {
      throw new AppError(400, "invalid_page", "Page must be >= 1");
    }

    const limit = 25;

    const resDb = await pool.query(
      `SELECT id, amount, reason, transfer_id, created_at
     FROM ledger
     WHERE account_id = $1
     ORDER BY id DESC
     LIMIT $2`,
      [accountId, limit + 1],
    );

    const rows = resDb.rows;
    const hasMore = rows.length > limit;
    if (hasMore) {
      rows.pop();
    }

    res.json({
      items: rows,
      page,
      has_more: hasMore,
    });
  }),
);

export default router;
