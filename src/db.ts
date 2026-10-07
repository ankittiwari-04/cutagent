import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:dev@localhost:5432/cutagent",
});
