-- ============================================================
-- 《了凡四训》逐句精读 —— 阅读进度与笔记
--
-- 注意：这个文件里的表会建在**与 ESAT 共用的数据库** esat-account-data 里，
-- 用户与会话直接复用 ESAT 已有的 users / sessions 表，因此两个站点是同一套账号。
--
-- 因为共用数据库，这里刻意**不使用 wrangler d1 migrations**（迁移记录表是数据库级别的，
-- 两个项目各自维护会产生冲突）。改用可重复执行的建表语句：
--     npm run db:init        # = wrangler d1 execute DB --remote --file=./schema/liaofan.sql
-- 全部使用 IF NOT EXISTS，重复执行不会破坏已有数据。
-- ============================================================

CREATE TABLE IF NOT EXISTS lf_progress (
  user_id    TEXT    NOT NULL,
  section_id TEXT    NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  pos        INTEGER NOT NULL DEFAULT 0,
  revealed   TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, section_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS lf_progress_user_idx ON lf_progress(user_id);

CREATE TABLE IF NOT EXISTS lf_notes (
  user_id    TEXT    NOT NULL,
  section_id TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, section_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS lf_notes_user_idx ON lf_notes(user_id);
