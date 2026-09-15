import { neon } from "@neondatabase/serverless"
import { migrations } from "./schema.js"

export interface Database {
  query<T = Record<string, unknown>>(
    text: string,
    parameters?: unknown[]
  ): Promise<T[]>
}

export const neonDatabase = (url: string): Database => {
  const sql = neon(url)
  return {
    query: async <T>(text: string, parameters: unknown[] = []) =>
      (await sql.query(text, parameters)) as T[]
  }
}

export const migrate = async (db: Database): Promise<void> => {
  for (const statement of migrations) await db.query(statement)
}
