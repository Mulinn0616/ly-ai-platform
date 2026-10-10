module.exports = {
  port: process.env.PORT || 3000,

  // 【管理员初始账号】仅数据库首次初始化时写入
  // 部署后请立即登录后台 → 基础配置 → 修改密码
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'ly@2024admin',
  },

  sessionSecret: process.env.SESSION_SECRET || 'ly-platform-secret-change-me',

  // 云端持久化磁盘建议改到 /data 挂载目录
  dbFile: process.env.DB_FILE || './data/ly.db',
  uploadDir: process.env.UPLOAD_DIR || './uploads',

  maxFileSize: 10 * 1024 * 1024,   // 单文件 10MB
  maxFiles: 5,                      // 最多 5 个

  maxLoginAttempts: 5,              // 登录失败上限
  lockMinutes: 10,                  // 锁定时长（分钟）
};