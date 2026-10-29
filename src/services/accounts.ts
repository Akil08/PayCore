import { pool } from "../db.js";

export async function getAccountById(accountId: string) {
  const res = await pool.query(
    `SELECT a.id, a.user_id, a.type, a.balance, a.status, u.email
     FROM accounts a
     LEFT JOIN users u ON a.user_id = u.id
     WHERE a.id = $1`,
    [accountId],
  );
  return res.rows[0] || null;
}

export async function getAccountByEmail(email: string) {
  const res = await pool.query(
    `SELECT a.id, u.email
     FROM accounts a
     JOIN users u ON a.user_id = u.id
     WHERE u.email = $1 AND a.type = 'user'`,
    [email],
  );
  return res.rows[0] || null;
}
