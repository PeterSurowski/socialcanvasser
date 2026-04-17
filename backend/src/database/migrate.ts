import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
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

function isSkippableMigrationError(err: any) {
  const code = err?.code
  return [
    'ER_DUP_FIELDNAME',
    'ER_TABLE_EXISTS_ERROR',
    'ER_DUP_KEYNAME',
    'ER_DUP_ENTRY',
    'ER_FK_DUP_NAME',
    'ER_MULTIPLE_PRI_KEY'
  ].includes(code)
}

async function resolveMigrationsDir() {
  const currentFile = fileURLToPath(import.meta.url)
  const currentDir = path.dirname(currentFile)

  const candidates = [
    path.resolve(process.cwd(), 'database', 'migrations'),
    path.resolve(process.cwd(), '..', 'database', 'migrations'),
    path.resolve(currentDir, '..', '..', '..', 'database', 'migrations'),
    path.resolve(currentDir, '..', '..', 'database', 'migrations')
  ]

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isDirectory()) {
        return candidate
      }
    } catch {
      // Try next candidate
    }
  }

  throw new Error(`Could not locate database/migrations directory. Checked: ${candidates.join(', ')}`)
}

async function runMigrations() {
  const migrationsDir = await resolveMigrationsDir()
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
          try {
            await connection.query(stmt)
          } catch (err) {
            if (isSkippableMigrationError(err)) {
              console.log(`Skipping already-applied statement in ${file}: ${err instanceof Error ? err.message : String(err)}`)
              continue
            }
            throw err
          }
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
