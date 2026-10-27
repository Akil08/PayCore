import "dotenv/config";

export const EXTERNAL_BANK_ID = "00000000-0000-0000-0000-000000000001";
export const IN_TRANSIT_ID = "00000000-0000-0000-0000-000000000002";

const getEnv = (key: string, fallback?: string): string => {
  const value = process.env[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const getEnvInt = (key: string, fallback: number): number => {
  const value = process.env[key];
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed))
    throw new Error(`Invalid integer for environment variable: ${key}`);
  return parsed;
};

const getEnvFloat = (key: string, fallback: number): number => {
  const value = process.env[key];
  if (value === undefined) return fallback;
  const parsed = parseFloat(value);
  if (isNaN(parsed))
    throw new Error(`Invalid float for environment variable: ${key}`);
  return parsed;
};

const getEnvBool = (key: string, fallback: boolean): boolean => {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
};

const DATABASE_URL = getEnv("DATABASE_URL");
const JWT_SECRET = getEnv("JWT_SECRET");
const RUN_WORKERS = getEnv("RUN_WORKERS", "true");

if (RUN_WORKERS !== "false" && !process.env.RABBITMQ_URL) {
  throw new Error(
    "Missing required environment variable: RABBITMQ_URL (required when RUN_WORKERS is not false)",
  );
}

export const config = {
  PORT: getEnvInt("PORT", 3000),
  DATABASE_URL,
  DATABASE_SSL: getEnvBool("DATABASE_SSL", false),
  PG_POOL_MAX: getEnvInt("PG_POOL_MAX", 10),
  RABBITMQ_URL: process.env.RABBITMQ_URL || "",
  JWT_SECRET,
  RUN_WORKERS: RUN_WORKERS !== "false",
  SETTLE_FAILURE_RATE: getEnvFloat("SETTLE_FAILURE_RATE", 0),
  HOLD_EXPIRY_SECONDS: getEnvInt("HOLD_EXPIRY_SECONDS", 300),
  EXPIRY_SWEEP_MS: getEnvInt("EXPIRY_SWEEP_MS", 30000),
  RECON_INTERVAL_MS: getEnvInt("RECON_INTERVAL_MS", 300000),
  CLUSTER_FLAG_SIZE: getEnvInt("CLUSTER_FLAG_SIZE", 5),
  SEED_ANALYST_PASSWORD: getEnv("SEED_ANALYST_PASSWORD", "Analyst#12345"),
  SEED_USER_PASSWORD: getEnv("SEED_USER_PASSWORD", "User#12345"),
} as const;
