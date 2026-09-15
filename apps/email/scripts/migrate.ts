import { migrate, postgresDatabase } from "../src/database.js"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
await migrate(postgresDatabase(process.env.DATABASE_URL))
console.log("Email schema is ready")
