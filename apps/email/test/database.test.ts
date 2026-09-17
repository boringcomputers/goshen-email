import { beforeEach, describe, expect, it, vi } from "vitest"

const fake = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn(), on: vi.fn() }))
vi.mock("pg", () => ({ Client: class {
  connect = fake.connect
  query = fake.query
  end = fake.end
  on = fake.on
} }))
import { postgresDatabase } from "../src/database.js"

describe("PostgreSQL connection failures", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fake.connect.mockResolvedValue(undefined)
    fake.query.mockResolvedValue({ rows: [{ reserved: true }] })
    fake.end.mockResolvedValue(undefined)
  })
  const db = postgresDatabase("postgres://test:test@localhost/test")
  it("preserves a committed result when disconnect fails", async () => {
    fake.end.mockRejectedValue(new Error("disconnected"))
    expect(await db.query("select mail.reserve_send($1, $2, $3)", ["inbox", "key", "hash"]))
      .toEqual([{ reserved: true }])
    expect(fake.query).toHaveBeenCalledTimes(1)
  })
  it("closes a failed query without retrying an uncertain write", async () => {
    const failure = new Error("connection lost after submission")
    fake.query.mockRejectedValue(failure)
    fake.end.mockRejectedValue(new Error("already closed"))
    await expect(db.query("select mail.reserve_send($1, $2, $3)", ["inbox", "key", "hash"]))
      .rejects.toBe(failure)
    expect(fake.query).toHaveBeenCalledTimes(1)
    expect(fake.end).toHaveBeenCalledTimes(1)
  })
  it("cleans up a connection that fails before executing SQL", async () => {
    const failure = new Error("connection refused")
    fake.connect.mockRejectedValue(failure)
    await expect(db.query("select 1")).rejects.toBe(failure)
    expect(fake.query).not.toHaveBeenCalled()
    expect(fake.end).toHaveBeenCalledTimes(1)
  })
  it("keeps transaction queries on one connection and commits before disconnecting", async () => {
    fake.end.mockRejectedValue(new Error("disconnected"))
    const result = await db.transaction(async tx => {
      await tx.query("select id from mail.customers where id = $1 for update", ["customer"])
      return tx.query("select 2")
    })
    expect(result).toEqual([{ reserved: true }])
    expect(fake.connect).toHaveBeenCalledTimes(1)
    expect(fake.query.mock.calls.map(call => call[0])).toEqual([
      "begin", "select id from mail.customers where id = $1 for update", "select 2", "commit",
    ])
    expect(fake.end).toHaveBeenCalledTimes(1)
  })
  it("rolls back a failed transaction without retrying its callback", async () => {
    const failure = new Error("lookup failed"), task = vi.fn(async () => { throw failure })
    await expect(db.transaction(task)).rejects.toBe(failure)
    expect(task).toHaveBeenCalledTimes(1)
    expect(fake.query.mock.calls.map(call => call[0])).toEqual(["begin", "rollback"])
    expect(fake.end).toHaveBeenCalledTimes(1)
  })

})
