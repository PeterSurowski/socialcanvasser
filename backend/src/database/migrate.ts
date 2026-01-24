import fs from 'fs/promises'
import path from 'path'
import db from '../config/database.js'

async function ensureMigrationsTable(connection: any) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS migrations_applied (
      id INT PRIMARY KEY AUTO_INCREMENT,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `)
}

async function runMigrations() {
  const migrationsDir = path.resolve(process.cwd(), 'database', 'migrations')
  const files = await fs.readdir(migrationsDir).catch(() => [])
  files.sort()

  if (files.length === 0) {
    console.log('No migration files found in', migrationsDir)
    return
  }

  const connection = await db.getConnection()
  try {
    await ensureMigrationsTable(connection)

    for (const file of files) {
      if (!file.endsWith('.sql')) continue

      const [rows] = await connection.query('SELECT filename FROM migrations_applied WHERE filename = ?', [file])
      if (Array.isArray(rows) && rows.length > 0) {
        console.log(`Skipping already-applied migration: ${file}`)
        continue
      }

      console.log(`Applying migration: ${file}`)
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8')

      await connection.beginTransaction()
      try {
        // Execute statements; split on semicolon and run non-empty statements.
        const parts = sql.split(';').map(s => s.trim()).filter(Boolean)
        for (const stmt of parts) {
          await connection.query(stmt)
        }

        await connection.query('INSERT INTO migrations_applied (filename) VALUES (?)', [file])
        await connection.commit()
        console.log(`Migration applied: ${file}`)
      } catch (err) {
        await connection.rollback()
        console.error(`Failed to apply migration ${file}:`, err)
        throw err
      }
    }
  } finally {
    connection.release()
  }
}

runMigrations()
  .then(() => {
    console.log('Migrations complete')
    process.exit(0)
  })
  .catch((err) => {
    console.error('Migrations failed:', err)
    process.exit(1)
  })
