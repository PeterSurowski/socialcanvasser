import db from '../src/config/database.js';

async function main() {
  const [rows] = await db.query(
    `SELECT id, account_identifier, 
     JSON_EXTRACT(session_data, '$.cookies[0].name') as first_cookie_name,
     JSON_EXTRACT(session_data, '$.cookies[0].value') as first_cookie_value
     FROM tiktok_accounts 
     WHERE user_id = 25`
  );
  
  console.log('Cookie comparison for accounts:');
  for (const row of rows as any[]) {
    console.log(`\nAccount ${row.id} (${row.account_identifier}):`);
    console.log(`  First cookie: ${row.first_cookie_name}`);
    console.log(`  Value: ${row.first_cookie_value?.substring(0, 50)}...`);
  }
  
  // Check if cookies are identical
  const account130 = (rows as any[])[0];
  const account131 = (rows as any[])[1];
  
  if (account130.first_cookie_value === account131.first_cookie_value) {
    console.log('\n❌ PROBLEM: Both accounts have IDENTICAL cookies!');
    console.log('This means both accounts will show the same TikTok user when logging in.');
  } else {
    console.log('\n✅ Cookies are different between accounts');
  }
  
  process.exit(0);
}

main();
