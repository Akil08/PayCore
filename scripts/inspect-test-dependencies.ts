import { pool } from "../src/db.js";

async function main() {
  try {
    const accountIds = [
      "6e3dc59c-85b1-4136-abd3-bab9b85b7a89",
      "3b23937a-120d-4741-b33d-65ea8e894db5",
    ];

    for (const table of [
      "account_clusters",
      "account_devices",
      "account_flag_log",
      "signals",
      "user_stats",
    ]) {
      // Table names are fixed constants from the schema, not user input.
      const result = await pool.query(
        `SELECT * FROM ${table} WHERE account_id = ANY($1::uuid[])`,
        [accountIds],
      );

      console.log(`\n${table}:`);
      console.table(result.rows);
    }
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
