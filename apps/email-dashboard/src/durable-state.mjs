import { createHash, randomBytes } from 'node:crypto'

class StoredMap {
  constructor(sql, collection) { this.sql = sql; this.collection = collection }
  get(key) {
    const row = this.sql.exec('SELECT value FROM dashboard_state WHERE collection = ? AND key = ?', this.collection, key).toArray()[0]
    return row ? JSON.parse(row.value) : undefined
  }
  set(key, value) {
    this.sql.exec('INSERT OR REPLACE INTO dashboard_state (collection, key, value) VALUES (?, ?, ?)', this.collection, key, JSON.stringify(value))
    return this
  }
  delete(key) { this.sql.exec('DELETE FROM dashboard_state WHERE collection = ? AND key = ?', this.collection, key) }
  get size() { return this.sql.exec('SELECT count(*) AS total FROM dashboard_state WHERE collection = ?', this.collection).one().total }
  *[Symbol.iterator]() {
    for (const row of this.sql.exec('SELECT key, value FROM dashboard_state WHERE collection = ? ORDER BY rowid', this.collection)) yield [row.key, JSON.parse(row.value)]
  }
  *keys() { for (const [key] of this) yield key }
}

export function durableState(sql, password) {
  sql.exec('CREATE TABLE IF NOT EXISTS dashboard_state (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, key))')
  const metadata = new StoredMap(sql, 'metadata')
  const fingerprint = createHash('sha256').update(password).digest('hex')
  if (metadata.get('password') !== fingerprint) {
    sql.exec('DELETE FROM dashboard_state')
    metadata.set('password', fingerprint)
    metadata.set('signingKey', randomBytes(32).toString('base64'))
  }
  return {
    signingKey: Buffer.from(metadata.get('signingKey'), 'base64'),
    sessions: new StoredMap(sql, 'sessions'),
    attempts: new StoredMap(sql, 'attempts'),
  }
}
