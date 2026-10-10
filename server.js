const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { db, getCfg, setCfg, hashPassword } = require('./db');
const config = require('./config');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 },
}));

const now = () => new Date().toISOString();
const safeJson = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const runGet = (stmt, params) => Object.keys(params).length ? stmt.get(params) : stmt.get();
const parseSkill = (row) => row ? {
  ...row,
  screenshot_list: safeJson(row.screenshot_list),
  attachments: safeJson(row.attachments),
} : row;

/* ========== 上传配置 ========== */
fs.mkdirSync(config.uploadDir, { recursive: true });

const ALLOW_EXT = ['.png','.jpg','.jpeg','.gif','.webp','.pdf','.doc','.docx','.xls','.xlsx','.zip','.rar','.7z'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    cb(null, Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxFileSize, files: config.maxFiles },
  fileFilter: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    if (!ALLOW_EXT.includes(ext)) return cb(new Error('不支持的文件类型：' + ext), false);
    cb(null, true);
  },
});

/* ========== 静态资源 ========== */
app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

/* =======================================================
   公开接口
   ======================================================= */

app.get('/api/meta', (req, res) => {
  res.json({
    depts: safeJson(getCfg('depts')),
    tags: safeJson(getCfg('tags')),
  });
});

app.get('/api/stats', (req, res) => {
  const onlineSkills = db.prepare(`SELECT COUNT(*) c FROM skills WHERE audit_status='online'`).get().c;
  const totalSubmissions = db.prepare(`SELECT COUNT(*) c FROM skills`).get().c;
  res.json({ onlineSkills, totalSubmissions });
});

app.get('/api/notices', (req, res) => {
  res.json(db.prepare('SELECT * FROM notices ORDER BY id DESC').all());
});

/* 技能列表（仅已上线） */
app.get('/api/skills', (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const tag = String(req.query.tag || '').trim();
  const dept = String(req.query.dept || '').trim();
  const sort = req.query.sort === 'hot' ? 'hot' : 'latest';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(60, Math.max(1, parseInt(req.query.pageSize) || 6));

  const where = [`audit_status='online'`];
  const params = {};

  if (keyword) {
    where.push(`(skill_name LIKE @kw OR scene_desc LIKE @kw OR tags LIKE @kw OR submit_dept LIKE @kw OR author LIKE @kw)`);
    params.kw = `%${keyword}%`;
  }
  if (tag) { where.push(`tags LIKE @tag`); params.tag = `%${tag}%`; }
  if (dept) { where.push(`submit_dept = @dept`); params.dept = dept; }

  const whereSql = 'WHERE ' + where.join(' AND ');
  const orderSql = sort === 'hot'
    ? 'ORDER BY view_count DESC, id DESC'
    : 'ORDER BY submit_time DESC, id DESC';

  const total = runGet(db.prepare(`SELECT COUNT(*) c FROM skills ${whereSql}`), params).c;
  const list = db.prepare(`SELECT * FROM skills ${whereSql} ${orderSql} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  res.json({
    list: list.map(parseSkill),
    total, page, pageSize,
    totalPages: Math.ceil(total / pageSize) || 1,
  });
});

/* 技能详情 */
app.get('/api/skills/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM skills WHERE id=? AND audit_status='online'`).get(req.params.id);
  if (!row) return res.status(404).json({ error: '技能不存在或已下架' });
  res.json(parseSkill(row));
});

/* 浏览量 +1 */
app.post('/api/skills/:id/view', (req, res) => {
  const r = db.prepare(`UPDATE skills SET view_count=view_count+1 WHERE id=? AND audit_status='online'`).run(req.params.id);
  res.json({ ok: r.changes > 0 });
});

/* 复制计数 +1 */
app.post('/api/skills/:id/copy', (req, res) => {
  const r = db.prepare(`UPDATE skills SET copy_download_count=copy_download_count+1 WHERE id=? AND audit_status='online'`).run(req.params.id);
  res.json({ ok: r.changes > 0 });
});

/* 附件下载计数 +1 */
app.post('/api/skills/:id/pic-download', (req, res) => {
  const r = db.prepare(`UPDATE skills SET pic_download_count=pic_download_count+1 WHERE id=? AND audit_status='online'`).run(req.params.id);
  res.json({ ok: r.changes > 0 });
});

/* 访客投稿 */
app.post('/api/submit', upload.array('attachments', config.maxFiles), (req, res) => {
  try {
    const {
      skill_name = '', author = '', submit_dept = '',
      scene_desc = '', benefit = '', skill_content = '',
      operation_desc = '', tags = '',
    } = req.body;

    if (!skill_name.trim() || !author.trim() || !submit_dept.trim() ||
        !scene_desc.trim() || !benefit.trim() || !skill_content.trim() ||
        !operation_desc.trim() || !tags.trim()) {
      return res.status(400).json({ error: '请完整填写所有必填项' });
    }

    const files = (req.files || []).map(f => ({
      name: f.originalname,
      size: f.size,
      type: f.mimetype || '',
      isImage: /^image\//.test(f.mimetype),
      url: '/uploads/' + f.filename,
    }));

    if (!files.length) return res.status(400).json({ error: '请至少上传 1 个附件' });

    const info = db.prepare(`
      INSERT INTO skills
        (skill_name, author, submit_dept, scene_desc, benefit, skill_content,
         operation_desc, tags, screenshot_list, attachments, submit_time, audit_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending')
    `).run(
      skill_name.trim(), author.trim(), submit_dept.trim(), scene_desc.trim(),
      benefit.trim(), skill_content.trim(), operation_desc.trim(), tags.trim(),
      JSON.stringify([]), JSON.stringify(files), now()
    );

    res.json({
      ok: true,
      id: info.lastInsertRowid,
      message: '提交成功！将由智慧园区管理中心统一审核，审核通过后展示在平台。',
    });
  } catch (e) {
    console.error('[submit]', e);
    res.status(500).json({ error: '提交失败，请稍后重试' });
  }
});

/* =======================================================
   管理员认证
   ======================================================= */

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: '未登录或登录已过期' });
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const lockMs = config.lockMinutes * 60 * 1000;
  const rec = db.prepare('SELECT * FROM login_attempts WHERE ip=?').get(ip) || { count: 0, last_attempt: 0 };

  if (rec.count >= config.maxLoginAttempts && Date.now() - rec.last_attempt < lockMs) {
    const wait = Math.ceil((lockMs - (Date.now() - rec.last_attempt)) / 60000);
    return res.status(429).json({ error: `登录失败次数过多，请 ${wait} 分钟后再试` });
  }

  const { username = '', password = '' } = req.body || {};
  const storedUser = getCfg('admin_username');
  const salt = getCfg('admin_salt');
  const hash = getCfg('admin_password_hash');

  if (username === storedUser && hashPassword(password, salt) === hash) {
    db.prepare('DELETE FROM login_attempts WHERE ip=?').run(ip);
    req.session.admin = true;
    return res.json({ ok: true });
  }

  const next = (Date.now() - rec.last_attempt < lockMs) ? rec.count + 1 : 1;
  db.prepare('INSERT OR REPLACE INTO login_attempts (ip, count, last_attempt) VALUES (?,?,?)')
    .run(ip, next, Date.now());

  const remain = Math.max(0, config.maxLoginAttempts - next);
  res.status(401).json({
    error: remain > 0 ? `用户名或密码错误，剩余尝试次数 ${remain} 次` : '尝试次数过多，账号已临时锁定',
  });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ username: getCfg('admin_username') });
});

/* =======================================================
   管理员：技能管理
   ======================================================= */

app.get('/api/admin/skills', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'all');
  const keyword = String(req.query.keyword || '').trim();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 20));

  const where = [];
  const params = {};
  if (status !== 'all') { where.push('audit_status = @status'); params.status = status; }
  if (keyword) {
    where.push('(skill_name LIKE @kw OR submit_dept LIKE @kw OR scene_desc LIKE @kw OR author LIKE @kw)');
    params.kw = `%${keyword}%`;
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = runGet(db.prepare(`SELECT COUNT(*) c FROM skills ${whereSql}`), params).c;
  const list = db.prepare(`SELECT * FROM skills ${whereSql} ORDER BY submit_time DESC, id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  res.json({
    list: list.map(parseSkill),
    total, page, pageSize,
    totalPages: Math.ceil(total / pageSize) || 1,
  });
});

app.post('/api/admin/skills/:id/approve', requireAdmin, (req, res) => {
  db.prepare(`UPDATE skills SET audit_status='online', audit_note='' WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/skills/:id/reject', requireAdmin, (req, res) => {
  const note = String((req.body && req.body.note) || '').trim();
  if (!note) return res.status(400).json({ error: '请填写驳回备注' });
  db.prepare(`UPDATE skills SET audit_status='rejected', audit_note=? WHERE id=?`).run(note, req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/skills/:id/offline', requireAdmin, (req, res) => {
  db.prepare(`UPDATE skills SET audit_status='offline' WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/skills/:id/online', requireAdmin, (req, res) => {
  db.prepare(`UPDATE skills SET audit_status='online' WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/skills/:id', requireAdmin, (req, res) => {
  // 顺便删除磁盘上的附件
  const row = db.prepare('SELECT attachments FROM skills WHERE id=?').get(req.params.id);
  if (row) {
    const files = safeJson(row.attachments);
    files.forEach(f => {
      if (f.url && f.url.startsWith('/uploads/')) {
        const p = path.join(config.uploadDir, path.basename(f.url));
        try { fs.unlinkSync(p); } catch (e) {}
      }
    });
  }
  db.prepare('DELETE FROM skills WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.put('/api/admin/skills/:id', requireAdmin, (req, res) => {
  const cur = db.prepare('SELECT * FROM skills WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '记录不存在' });
  const b = req.body || {};
  db.prepare(`
    UPDATE skills SET
      skill_name=?, author=?, submit_dept=?, scene_desc=?, benefit=?, skill_content=?,
      operation_desc=?, tags=?, audit_status=?, audit_note=?
    WHERE id=?
  `).run(
    b.skill_name ?? cur.skill_name,
    b.author ?? cur.author,
    b.submit_dept ?? cur.submit_dept,
    b.scene_desc ?? cur.scene_desc,
    b.benefit ?? cur.benefit,
    b.skill_content ?? cur.skill_content,
    b.operation_desc ?? cur.operation_desc,
    b.tags ?? cur.tags,
    b.audit_status ?? cur.audit_status,
    b.audit_note ?? cur.audit_note,
    req.params.id
  );
  res.json({ ok: true });
});

/* =======================================================
   管理员：公告
   ======================================================= */

app.get('/api/admin/notices', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM notices ORDER BY id DESC').all());
});

app.post('/api/admin/notices', requireAdmin, (req, res) => {
  const { title = '', content = '' } = req.body || {};
  if (!title.trim() || !content.trim()) return res.status(400).json({ error: '标题和内容不能为空' });
  const info = db.prepare('INSERT INTO notices (title, content, create_time) VALUES (?,?,?)')
    .run(title.trim(), content.trim(), now());
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/admin/notices/:id', requireAdmin, (req, res) => {
  const { title = '', content = '' } = req.body || {};
  if (!title.trim() || !content.trim()) return res.status(400).json({ error: '标题和内容不能为空' });
  db.prepare('UPDATE notices SET title=?, content=? WHERE id=?').run(title.trim(), content.trim(), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/notices/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM notices WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* =======================================================
   管理员：统计 + 导出
   ======================================================= */

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const one = (sql) => db.prepare(sql).get().c;

  const summary = {
    total: one('SELECT COUNT(*) c FROM skills'),
    online: one(`SELECT COUNT(*) c FROM skills WHERE audit_status='online'`),
    pending: one(`SELECT COUNT(*) c FROM skills WHERE audit_status='pending'`),
    rejected: one(`SELECT COUNT(*) c FROM skills WHERE audit_status='rejected'`),
    offline: one(`SELECT COUNT(*) c FROM skills WHERE audit_status='offline'`),
  };

  const byDept = db.prepare(`
    SELECT submit_dept AS dept, COUNT(*) AS total,
           SUM(CASE WHEN audit_status='online' THEN 1 ELSE 0 END) AS online
    FROM skills GROUP BY submit_dept ORDER BY total DESC
  `).all();

  const topView = db.prepare(`
    SELECT id, skill_name, submit_dept, view_count, copy_download_count
    FROM skills WHERE audit_status='online'
    ORDER BY view_count DESC, id DESC LIMIT 10
  `).all();

  const topCopy = db.prepare(`
    SELECT id, skill_name, submit_dept, view_count, copy_download_count
    FROM skills WHERE audit_status='online'
    ORDER BY copy_download_count DESC, id DESC LIMIT 10
  `).all();

  const byMonth = db.prepare(`
    SELECT substr(submit_time,1,7) AS month, COUNT(*) AS total
    FROM skills GROUP BY month ORDER BY month DESC LIMIT 12
  `).all().reverse();

  res.json({ summary, byDept, topView, topCopy, byMonth });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM skills ORDER BY id DESC').all();
  const statusText = { pending: '待审核', online: '已上线', rejected: '已驳回', offline: '已下架' };

  const data = rows.map(r => {
    const shots = safeJson(r.screenshot_list);
    const atts = safeJson(r.attachments);
    return {
      'ID': r.id,
      '技能名称': r.skill_name,
      '提交人': r.author || '',
      '提交园区/部门': r.submit_dept,
      '带来的帮助': r.benefit || '',
      '业务应用场景': r.scene_desc,
      '指令参考': r.skill_content,
      '使用操作说明': r.operation_desc,
      '业务标签': r.tags,
      '附件数量': atts.length,
      '附件列表': atts.map(f => f.name).join(' | '),
      '截图数量': shots.length,
      '提交时间': r.submit_time,
      '审核状态': statusText[r.audit_status] || r.audit_status,
      '审核备注': r.audit_note,
      '浏览次数': r.view_count,
      '复制次数': r.copy_download_count,
      '附件下载次数': r.pic_download_count,
    };
  });

  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [
    { wch: 6 }, { wch: 24 }, { wch: 12 }, { wch: 18 }, { wch: 30 },
    { wch: 40 }, { wch: 60 }, { wch: 40 }, { wch: 20 }, { wch: 10 },
    { wch: 40 }, { wch: 10 }, { wch: 22 }, { wch: 10 }, { wch: 24 },
    { wch: 10 }, { wch: 12 }, { wch: 14 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Skill数据');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const fname = `LY-AI-Skill-导出-${new Date().toISOString().slice(0,10)}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

/* =======================================================
   管理员：基础配置
   ======================================================= */

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({
    depts: safeJson(getCfg('depts')),
    tags: safeJson(getCfg('tags')),
    adminUsername: getCfg('admin_username'),
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const { depts, tags } = req.body || {};
  if (Array.isArray(depts)) setCfg('depts', JSON.stringify(depts.map(s => String(s).trim()).filter(Boolean)));
  if (Array.isArray(tags)) setCfg('tags', JSON.stringify(tags.map(s => String(s).trim()).filter(Boolean)));
  res.json({ ok: true });
});

app.post('/api/admin/password', requireAdmin, (req, res) => {
  const { oldPassword = '', newPassword = '', newUsername = '' } = req.body || {};
  const salt = getCfg('admin_salt');

  if (hashPassword(oldPassword, salt) !== getCfg('admin_password_hash')) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '新密码长度至少 6 位' });
  }

  const newSalt = crypto.randomBytes(16).toString('hex');
  setCfg('admin_salt', newSalt);
  setCfg('admin_password_hash', hashPassword(newPassword, newSalt));
  if (newUsername.trim()) setCfg('admin_username', newUsername.trim());

  res.json({ ok: true });
});

/* =======================================================
   路由兜底 + 错误处理
   ======================================================= */

app.get(['/admin', '/admin/'], (req, res) => res.redirect('/#/admin/login'));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '单个文件不能超过 10MB' });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: '最多上传 5 个文件' });
  }
  res.status(400).json({ error: err.message || '请求失败' });
});

app.listen(config.port, () => {
  console.log(`\n  LY行政AI应用共享平台已启动`);
  console.log(`  前台： http://localhost:${config.port}/`);
  console.log(`  后台： http://localhost:${config.port}/#/admin/login\n`);
});