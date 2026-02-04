import db from '../src/config/database.js';

async function main() {
  const [rows] = await db.query(
    `SELECT id, account_identifier, 
     JSON_LENGTH(session_data, '$.cookies') as cookie_count,
     JSON_EXTRACT(session_data, '$.ready') as ready
     FROM tiktok_accounts 
     WHERE user_id = 25`
  );
  
  console.log('Account cookies status:');
  console.table(rows);
  
  process.exit(0);
}

main();
