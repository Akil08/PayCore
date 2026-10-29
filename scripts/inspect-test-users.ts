import { pool } from "../src/db.js";

async function main() {
  try {
    const users = await pool.query(
      `SELECT
         u.id AS user_id,
         u.email,
         a.id AS account_id,
         a.balance
       FROM users u
       LEFT JOIN accounts a ON a.user_id = u.id
       WHERE u.email IN ($1, $2)`,
      ["alice_1793264994586@test.com", "bob_1793264994586@test.com"],
    );

    console.table(users.rows);

    const transfers = await pool.query(
      `SELECT DISTINCT t.*
       FROM transfers t
       JOIN accounts a
         ON a.id = t.sender_account_id
         OR a.id = t.receiver_account_id
       JOIN users u ON u.id = a.user_id
       WHERE u.email IN ($1, $2)`,
      ["alice_1793264994586@test.com", "bob_1793264994586@test.com"],
    );

    const ledger = await pool.query(
      `SELECT *
   FROM ledger
   WHERE transfer_id = $1
      OR account_id IN ($2, $3)
   ORDER BY created_at`,
      [
        "fa7c4286-f628-4e11-b0dd-023172aca3f2",
        "6e3dc59c-85b1-4136-abd3-bab9b85b7a89",
        "3b23937a-120d-4741-b33d-65ea8e894db5",
      ],
    );

    console.log("Related ledger entries:");
    console.table(ledger.rows);

    console.table(transfers.rows);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
