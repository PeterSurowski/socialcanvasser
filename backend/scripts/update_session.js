import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({ path: './.env' });

const id = parseInt(process.argv[2], 10);
const hostPort = parseInt(process.argv[3], 10);
const debugPort = parseInt(process.argv[4], 10);
const containerId = process.argv[5] || `sc_acc_${id}`;

if (!id || !hostPort || !debugPort) {
  console.error('Usage: node update_session.js <id> <hostPort> <debugPort> [containerId]');
  process.exit(2);
}

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'socialcanvasser'
    });

    const session = JSON.stringify({ type: 'container', containerId, hostPort, debugPort });
    const [r] = await conn.query('UPDATE tiktok_accounts SET session_data = ? WHERE id = ?', [session, id]);
    console.log('updated rows:', (r && r.affectedRows) || r.affected_rows || 0);
    const [rows] = await conn.query('SELECT id, session_data FROM tiktok_accounts WHERE id = ?', [id]);
    console.log(rows);
    await conn.end();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
