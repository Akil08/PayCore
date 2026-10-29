import { pool } from "../src/db.js";

async function main() {
  try {
    const result = await pool.query(`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS referenced_table,
        ccu.column_name AS referenced_column,
        tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.constraint_schema = kcu.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND (
          ccu.table_name IN ('users', 'accounts', 'transfers', 'ledger')
          OR tc.table_name IN ('users', 'accounts', 'transfers', 'ledger')
        )
      ORDER BY tc.table_name, kcu.column_name;
    `);

    console.table(result.rows);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
