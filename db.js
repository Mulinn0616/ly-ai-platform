const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  author TEXT DEFAULT '',
  submit_dept TEXT NOT NULL,
  scene_desc TEXT NOT NULL,
  benefit TEXT DEFAULT '',
  skill_content TEXT NOT NULL,
  operation_desc TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  screenshot_list TEXT DEFAULT '[]',
  attachments TEXT DEFAULT '[]',
  submit_time TEXT NOT NULL,
  audit_status TEXT NOT NULL DEFAULT 'pending',
  audit_note TEXT DEFAULT '',
  view_count INTEGER DEFAULT 0,
  copy_download_count INTEGER DEFAULT 0,
  pic_download_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(audit_status);
CREATE INDEX IF NOT EXISTS idx_skills_dept ON skills(submit_dept);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  create_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS configs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  last_attempt INTEGER DEFAULT 0
);
`);

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + '::' + password).digest('hex');
}

function getCfg(k) {
  const r = db.prepare('SELECT value FROM configs WHERE key = ?').get(k);
  return r ? r.value : null;
}
function setCfg(k, v) {
  db.prepare('INSERT OR REPLACE INTO configs (key, value) VALUES (?, ?)').run(k, v);
}

/* 首次启动初始化 */
if (!getCfg('admin_username')) setCfg('admin_username', config.admin.username);

if (!getCfg('admin_password_hash')) {
  const salt = crypto.randomBytes(16).toString('hex');
  setCfg('admin_salt', salt);
  setCfg('admin_password_hash', hashPassword(config.admin.password, salt));
}

if (!getCfg('depts')) {
  setCfg('depts', JSON.stringify([
    '智慧园区管理中心', '老领益园区', '裕元CNC园区', '田心园区', '太阳神园区',
    '东莞恒发园区', '平湖园区', '江门园区', '捷盈', '苏州新厂园区',
    '望亭园区', '东台小件园区', '东台模组园区', '扬州园区',
    '成都园区', '郑州园区', '越南园区', '桂林园区', '深圳宝安园区', '珠海园区',
    '东莞常平园区', '东莞大朗园区', '绵阳园区'
  ]));
}

if (!getCfg('tags')) {
  setCfg('tags', JSON.stringify(['数据整理', '会议纪要', '制度问答', '表格处理', '其它']));
}

module.exports = { db, getCfg, setCfg, hashPassword };