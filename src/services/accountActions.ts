import { PoolClient } from "pg";
import { AppError } from "../http/errors.js";

export async function freezeAccount(
  client: PoolClient,
  accountId: string,
  reason: string,
  setBy: "analyzer" | "analyst",
): Promise<void> {
  const res = await client.query(
    "UPDATE accounts SET status = 'frozen' WHERE id = $1 AND status = 'active' RETURNING id",
    [accountId],
  );
  if (res.rowCount === 0) {
    throw new AppError(
      409,
      "invalid_state",
      "Account must be active to be frozen",
    );
  }
  await client.query(
    "INSERT INTO account_flag_log (account_id, action, reason, set_by) VALUES ($1, $2, $3, $4)",
    [accountId, "freeze", reason, setBy],
  );
}

export async function unfreezeAccount(
  client: PoolClient,
  accountId: string,
  reason: string,
  setBy: "analyzer" | "analyst",
): Promise<void> {
  const res = await client.query(
    "UPDATE accounts SET status = 'active' WHERE id = $1 AND status = 'frozen' RETURNING id",
    [accountId],
  );
  if (res.rowCount === 0) {
    throw new AppError(
      409,
      "invalid_state",
      "Account must be frozen to be unfrozen",
    );
  }
  await client.query(
    "INSERT INTO account_flag_log (account_id, action, reason, set_by) VALUES ($1, $2, $3, $4)",
    [accountId, "unfreeze", reason, setBy],
  );
}

export async function blacklistAccount(
  client: PoolClient,
  accountId: string,
  reason: string,
  setBy: "analyzer" | "analyst",
): Promise<void> {
  const res = await client.query(
    "UPDATE accounts SET status = 'blacklisted' WHERE id = $1 AND status IN ('active', 'frozen') RETURNING id",
    [accountId],
  );
  if (res.rowCount === 0) {
    throw new AppError(
      409,
      "invalid_state",
      "Account must be active or frozen to be blacklisted",
    );
  }
  await client.query(
    "INSERT INTO account_flag_log (account_id, action, reason, set_by) VALUES ($1, $2, $3, $4)",
    [accountId, "blacklist", reason, setBy],
  );
}

export async function unblacklistAccount(
  client: PoolClient,
  accountId: string,
  reason: string,
  setBy: "analyzer" | "analyst",
): Promise<void> {
  const res = await client.query(
    "UPDATE accounts SET status = 'active' WHERE id = $1 AND status = 'blacklisted' RETURNING id",
    [accountId],
  );
  if (res.rowCount === 0) {
    throw new AppError(
      409,
      "invalid_state",
      "Account must be blacklisted to be unblacklisted",
    );
  }
  await client.query(
    "INSERT INTO account_flag_log (account_id, action, reason, set_by) VALUES ($1, $2, $3, $4)",
    [accountId, "unblacklist", reason, setBy],
  );
}
