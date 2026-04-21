/**
 * export-affiliate-data.ts
 *
 * Exports all Affiliate Procurement data from the local (dev) database and
 * generates a self-contained SQL file that can be safely imported on a
 * production machine.
 *
 * Key behaviour:
 *  - incogniton_account_id is remapped by account NAME (account_identifier),
 *    NOT by numeric ID, so it will resolve correctly on prod even though the
 *    tiktok_accounts rows have different primary-key IDs there.
 *  - affiliate_prospects uses INSERT … ON DUPLICATE KEY UPDATE so existing
 *    prod rows are UPDATED, not duplicated.
 *  - affiliate_interacted_videos uses INSERT IGNORE so already-seen videos
 *    are skipped.
 *  - user_config is never INSERT-ed; only the affiliate-specific columns are
 *    patched via UPDATE … WHERE user_id already exists.
 *  - activity_logs (affiliate actions) are exported with account-name remapping
 *    and INSERT IGNORE so they are additive only.
 *
 * Usage (from the repo root):
 *   cd backend
 *   npx tsx scripts/export-affiliate-data.ts
 *
 * Output:
 *   affiliate-data-export-<timestamp>.sql  (in repo root)
 */

import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

// ──────────────────────────────────────────────────────────────────────────────
// DB config — edit if your local credentials differ
// ──────────────────────────────────────────────────────────────────────────────
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'socialcanvasser',
  multipleStatements: true,
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Escape a JS value for safe embedding in a SQL literal */
function sqlVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
  // string — escape backslashes, single-quotes, NUL bytes
  const s = String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\0/g, '\\0');
  return `'${s}'`;
}

/** Format a raw DB row's timestamp/date columns back to strings */
function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : v;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const conn = await mysql.createConnection(DB_CONFIG);
  const lines: string[] = [];

  const banner = (msg: string) => {
    lines.push('');
    lines.push('-- ' + '─'.repeat(70));
    lines.push(`-- ${msg}`);
    lines.push('-- ' + '─'.repeat(70));
  };

  lines.push('-- ============================================================');
  lines.push('-- Affiliate Procurement data export');
  lines.push(`-- Generated: ${new Date().toISOString()}`);
  lines.push('-- Source DB : ' + DB_CONFIG.database + ' @ ' + DB_CONFIG.host);
  lines.push('-- ============================================================');
  lines.push('');
  lines.push('USE socialcanvasser;');
  lines.push('');
  lines.push('SET FOREIGN_KEY_CHECKS = 0;');

  // ── 1. user_config – patch affiliate columns only ──────────────────────────
  banner('1. user_config — affiliate columns only (UPDATE, no INSERT)');
  lines.push('-- These UPDATE statements only touch affiliate-specific columns.');
  lines.push('-- They will silently do nothing if the user_id does not yet exist on prod');
  lines.push('-- (safe to run multiple times).');
  lines.push('');

  const [configRows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT
       u.username,
       uc.snooze_days,
       uc.keep_in_touch_snooze_days,
       uc.affiliate_invitation_text,
       uc.affiliate_dm_eds_threshold,
       uc.affiliate_automation_enabled
     FROM user_config uc
     JOIN users u ON u.id = uc.user_id`
  );

  for (const raw of configRows) {
    const r = normaliseRow(raw);
    lines.push(
      `UPDATE user_config uc` +
      `  JOIN users u ON u.id = uc.user_id AND u.username = ${sqlVal(r.username)}` +
      `  SET` +
      `    uc.snooze_days                 = ${sqlVal(r.snooze_days)},` +
      `    uc.keep_in_touch_snooze_days   = ${sqlVal(r.keep_in_touch_snooze_days)},` +
      `    uc.affiliate_dm_eds_threshold  = ${sqlVal(r.affiliate_dm_eds_threshold)},` +
      `    uc.affiliate_automation_enabled= ${sqlVal(r.affiliate_automation_enabled)},` +
      `    uc.affiliate_invitation_text   = ${sqlVal(r.affiliate_invitation_text)};`
    );
  }

  // ── 2. affiliate_prospects ─────────────────────────────────────────────────
  banner('2. affiliate_prospects');
  lines.push(
    '-- incogniton_account_id is resolved on the TARGET machine by joining on'
  );
  lines.push('-- tiktok_accounts.account_identifier (the human-readable profile name).');
  lines.push('-- ON DUPLICATE KEY UPDATE applies the latest state without losing history.');
  lines.push('');

  const [prospects] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT
       ap.*,
       u.username  AS _owner_username,
       ta.account_identifier AS _account_name
     FROM affiliate_prospects ap
     JOIN users u ON u.id = ap.user_id
     LEFT JOIN tiktok_accounts ta ON ta.id = ap.incogniton_account_id`
  );

  if (prospects.length === 0) {
    lines.push('-- (no affiliate_prospects rows found)');
  }

  for (const raw of prospects) {
    const r = normaliseRow(raw);

    // Build the incogniton_account_id expression: a subquery by name, or NULL
    const accountIdExpr = r._account_name
      ? `(SELECT id FROM tiktok_accounts WHERE account_identifier = ${sqlVal(r._account_name)} LIMIT 1)`
      : 'NULL';

    lines.push(
      `INSERT INTO affiliate_prospects` +
      ` (user_id, tiktok_username, profile_url, incogniton_account_id,` +
      `  engagement_depth_score, interaction_sessions, bio_scraped, bio_text,` +
      `  user_title, is_following, is_following_us, is_keep_in_touch,` +
      `  snoozed_until, dm_sent, dm_sent_at, last_interaction_at, created_at, updated_at)` +
      ` SELECT` +
      `   u.id,` +
      `   ${sqlVal(r.tiktok_username)},` +
      `   ${sqlVal(r.profile_url)},` +
      `   ${accountIdExpr},` +
      `   ${sqlVal(r.engagement_depth_score)},` +
      `   ${sqlVal(r.interaction_sessions)},` +
      `   ${sqlVal(r.bio_scraped)},` +
      `   ${sqlVal(r.bio_text)},` +
      `   ${sqlVal(r.user_title)},` +
      `   ${sqlVal(r.is_following)},` +
      `   ${sqlVal(r.is_following_us)},` +
      `   ${sqlVal(r.is_keep_in_touch)},` +
      `   ${sqlVal(r.snoozed_until)},` +
      `   ${sqlVal(r.dm_sent)},` +
      `   ${sqlVal(r.dm_sent_at)},` +
      `   ${sqlVal(r.last_interaction_at)},` +
      `   ${sqlVal(r.created_at)},` +
      `   ${sqlVal(r.updated_at)}` +
      `   FROM users u WHERE u.username = ${sqlVal(r._owner_username)}` +
      ` ON DUPLICATE KEY UPDATE` +
      `   incogniton_account_id  = VALUES(incogniton_account_id),` +
      `   engagement_depth_score = VALUES(engagement_depth_score),` +
      `   interaction_sessions   = VALUES(interaction_sessions),` +
      `   bio_scraped            = VALUES(bio_scraped),` +
      `   bio_text               = VALUES(bio_text),` +
      `   user_title             = VALUES(user_title),` +
      `   is_following           = VALUES(is_following),` +
      `   is_following_us        = VALUES(is_following_us),` +
      `   is_keep_in_touch       = VALUES(is_keep_in_touch),` +
      `   snoozed_until          = VALUES(snoozed_until),` +
      `   dm_sent                = VALUES(dm_sent),` +
      `   dm_sent_at             = VALUES(dm_sent_at),` +
      `   last_interaction_at    = VALUES(last_interaction_at),` +
      `   updated_at             = VALUES(updated_at);`
    );
  }

  // ── 3. affiliate_interacted_videos ─────────────────────────────────────────
  banner('3. affiliate_interacted_videos');
  lines.push('-- INSERT IGNORE: already-imported videos are silently skipped.');
  lines.push('');

  const [videos] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT aiv.*, u.username AS _owner_username
     FROM affiliate_interacted_videos aiv
     JOIN users u ON u.id = aiv.user_id`
  );

  if (videos.length === 0) {
    lines.push('-- (no affiliate_interacted_videos rows found)');
  }

  for (const raw of videos) {
    const r = normaliseRow(raw);
    lines.push(
      `INSERT IGNORE INTO affiliate_interacted_videos` +
      ` (user_id, video_url, tiktok_username, caption, comments_json,` +
      `  liked, comment_posted, interacted_at)` +
      ` SELECT u.id,` +
      `   ${sqlVal(r.video_url)},` +
      `   ${sqlVal(r.tiktok_username)},` +
      `   ${sqlVal(r.caption)},` +
      `   ${sqlVal(r.comments_json)},` +
      `   ${sqlVal(r.liked)},` +
      `   ${sqlVal(r.comment_posted)},` +
      `   ${sqlVal(r.interacted_at)}` +
      ` FROM users u WHERE u.username = ${sqlVal(r._owner_username)};`
    );
  }

  // ── 4. activity_logs (affiliate actions only) ──────────────────────────────
  banner('4. activity_logs — affiliate actions only');
  lines.push(
    '-- Only affiliate_dm_sent and affiliate_comment_posted rows are exported.'
  );
  lines.push(
    '-- tiktok_account_id is remapped by account_identifier name, same as above.'
  );
  lines.push('-- INSERT IGNORE: duplicate rows (same primary key) are skipped.');
  lines.push('');

  const [logs] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT al.*, u.username AS _owner_username, ta.account_identifier AS _account_name
     FROM activity_logs al
     JOIN users u ON u.id = al.user_id
     LEFT JOIN tiktok_accounts ta ON ta.id = al.tiktok_account_id
     WHERE al.action_type IN ('affiliate_dm_sent', 'affiliate_comment_posted')`
  );

  if (logs.length === 0) {
    lines.push('-- (no affiliate activity_logs rows found)');
  }

  for (const raw of logs) {
    const r = normaliseRow(raw);
    const accountIdExpr = r._account_name
      ? `(SELECT id FROM tiktok_accounts WHERE account_identifier = ${sqlVal(r._account_name)} LIMIT 1)`
      : 'NULL';

    lines.push(
      `INSERT IGNORE INTO activity_logs` +
      ` (user_id, tiktok_account_id, action_type, target_user, post_url,` +
      `  message_content, success, error_message, created_at)` +
      ` SELECT u.id,` +
      `   ${accountIdExpr},` +
      `   ${sqlVal(r.action_type)},` +
      `   ${sqlVal(r.target_user)},` +
      `   ${sqlVal(r.post_url)},` +
      `   ${sqlVal(r.message_content)},` +
      `   ${sqlVal(r.success)},` +
      `   ${sqlVal(r.error_message)},` +
      `   ${sqlVal(r.created_at)}` +
      ` FROM users u WHERE u.username = ${sqlVal(r._owner_username)};`
    );
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push('SET FOREIGN_KEY_CHECKS = 1;');
  lines.push('');
  lines.push('-- ── Summary ──────────────────────────────────────────────────────────────');
  lines.push(`-- affiliate_prospects      : ${prospects.length} rows`);
  lines.push(`-- affiliate_interacted_videos: ${videos.length} rows`);
  lines.push(`-- activity_logs (affiliate): ${logs.length} rows`);
  lines.push(`-- user_config patches      : ${configRows.length} rows`);
  lines.push('-- ──────────────────────────────────────────────────────────────────────────');

  await conn.end();

  // ── Write file ─────────────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.resolve(process.cwd(), `../affiliate-data-export-${timestamp}.sql`);
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');

  console.log('\n✅  Export complete!');
  console.log(`   File : ${outFile}`);
  console.log(`   affiliate_prospects       : ${prospects.length} rows`);
  console.log(`   affiliate_interacted_videos: ${videos.length} rows`);
  console.log(`   activity_logs (affiliate) : ${logs.length} rows`);
  console.log(`   user_config patches       : ${configRows.length} rows`);
  console.log('\nNext steps:');
  console.log('  1. Copy the generated .sql file to your production machine.');
  console.log('  2. On prod, run the schema migrations first:');
  console.log('       cd backend && npm run migrate');
  console.log('  3. Then import the data:');
  console.log('       mysql -uroot -proot socialcanvasser < affiliate-data-export-*.sql');
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});
