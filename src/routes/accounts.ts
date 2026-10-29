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
