import { pool } from "../src/db.js";

async function main() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock and verify the exact test users and accounts.
    const users = await client.query(
      `SELECT u.id AS user_id, u.email, a.id AS account_id
       FROM users u
       JOIN accounts a ON a.user_id = u.id
       WHERE (u.id = $1 AND u.email = $2 AND a.id = $3)
          OR (u.id = $4 AND u.email = $5 AND a.id = $6)
       FOR UPDATE OF u, a`,
      [
        "b72c1135-2a45-4c4c-b662-b9495fcb6e51",
        "alice_1793264994586@test.com",
        "6e3dc59c-85b1-4136-abd3-bab9b85b7a89",
        "17d7ff20-775a-45bf-a321-1e19e7c13fa4",
        "bob_1793264994586@test.com",
        "3b23937a-120d-4741-b33d-65ea8e894db5",
      ],
    );

    if (users.rowCount !== 2) {
      throw new Error(
        `Expected exactly 2 matching test users/accounts; found ${users.rowCount}. Nothing will be deleted.`,
      );
    }

    const accountIds = [
      "6e3dc59c-85b1-4136-abd3-bab9b85b7a89",
      "3b23937a-120d-4741-b33d-65ea8e894db5",
    ];

    // Verify the only transfer involving these accounts is the known test transfer.
    const transfers = await client.query(
      `SELECT id
       FROM transfers
       WHERE sender_account_id = ANY($1::uuid[])
          OR receiver_account_id = ANY($1::uuid[])
       FOR UPDATE`,
      [accountIds],
    );

    const expectedTransferId = "fa7c4286-f628-4e11-b0dd-023172aca3f2";

    if (
      transfers.rowCount !== 1 ||
      transfers.rows[0].id !== expectedTransferId
    ) {
      throw new Error("Unexpected transfers found. Nothing will be deleted.");
    }

    // Remove ledger history only for these two test accounts
    // and the known test transfer. Never delete shared-account-only rows.
    const ledger = await client.query(
      `DELETE FROM ledger
       WHERE account_id = ANY($1::uuid[])
          OR transfer_id = $2`,
      [accountIds, expectedTransferId],
    );

    await client.query(`DELETE FROM transfers WHERE id = $1`, [
      expectedTransferId,
    ]);

    // Recheck dependent tables before removing the accounts.
    for (const table of [
      "account_clusters",
      "account_devices",
      "account_flag_log",
      "signals",
      "user_stats",
    ]) {
      const result = await client.query(
        `SELECT 1 FROM ${table} WHERE account_id = ANY($1::uuid[]) LIMIT 1`,
        [accountIds],
      );

      if (result.rowCount) {
        throw new Error(
          `Found dependent records in ${table}; aborting cleanup.`,
        );
      }
    }

    await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
      accountIds,
    ]);

    await client.query(
      `DELETE FROM users
       WHERE id = ANY($1::uuid[])
         AND email = ANY($2::text[])`,
      [
        [
          "b72c1135-2a45-4c4c-b662-b9495fcb6e51",
          "17d7ff20-775a-45bf-a321-1e19e7c13fa4",
        ],
        ["alice_1793264994586@test.com", "bob_1793264994586@test.com"],
      ],
    );

    await client.query("COMMIT");

    console.log("Cleanup committed.");
    console.log(`Ledger rows deleted: ${ledger.rowCount}`);
    console.log("Deleted the verified test transfer, accounts, and users.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Cleanup rolled back; no changes were committed.", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
