import { Client } from "pg";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const ssl =
    process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false;
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: ssl as any,
  });

  try {
    await client.connect();
    const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    await client.query(schemaSql);
    console.log("Database schema initialized successfully.");
  } catch (err) {
    console.error("Failed to initialize database schema:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
