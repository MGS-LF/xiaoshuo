import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, '..', 'data', 'novels.db');
const dataDir = path.dirname(databasePath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    genre TEXT NOT NULL,
    theme TEXT NOT NULL,
    chapter_count INTEGER NOT NULL,
    words_per_chapter INTEGER DEFAULT 2000,
    style TEXT DEFAULT '',
    extra_prompt TEXT DEFAULT '',
    status TEXT DEFAULT 'draft',
    outline_json TEXT,
    characters_json TEXT,
    timeline_json TEXT,
    plot_json TEXT,
    world_json TEXT,
    global_summary TEXT DEFAULT '',
    reference_project_id TEXT DEFAULT '',
    reference_mode TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    title TEXT DEFAULT '',
    outline TEXT DEFAULT '',
    content TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE(project_id, chapter_num)
  );

  CREATE TABLE IF NOT EXISTS chapter_memory (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    memory_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS generation_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    job_type TEXT NOT NULL DEFAULT 'outline',
    status TEXT NOT NULL DEFAULT 'running',
    total_batches INTEGER NOT NULL DEFAULT 1,
    completed_batches INTEGER NOT NULL DEFAULT 0,
    current_batch INTEGER NOT NULL DEFAULT 1,
    error TEXT DEFAULT '',
    checkpoint_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
`);

const projectColumns = new Set(
  db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name)
);
if (!projectColumns.has('reference_project_id')) {
  db.exec("ALTER TABLE projects ADD COLUMN reference_project_id TEXT DEFAULT ''");
}
if (!projectColumns.has('reference_mode')) {
  db.exec("ALTER TABLE projects ADD COLUMN reference_mode TEXT DEFAULT ''");
}

export function getSetting(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

export function createProject(p) {
  db.prepare(`
    INSERT INTO projects (id, title, genre, theme, chapter_count, words_per_chapter, style, extra_prompt, status)
    VALUES (@id, @title, @genre, @theme, @chapter_count, @words_per_chapter, @style, @extra_prompt, @status)
  `).run(p);
  return getProject(p.id);
}

export function updateProject(id, fields) {
  const allowed = [
    'title', 'genre', 'theme', 'chapter_count', 'words_per_chapter', 'style',
    'extra_prompt', 'status', 'outline_json', 'characters_json', 'timeline_json',
    'plot_json', 'world_json', 'global_summary', 'reference_project_id', 'reference_mode'
  ];
  const sets = [];
  const params = { id };
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = @${k}`);
      params[k] = fields[k];
    }
  }
  if (!sets.length) return getProject(id);
  sets.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getProject(id);
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function listProjects() {
  return db.prepare(`
    SELECT id, title, genre, theme, chapter_count, status, created_at, updated_at
    FROM projects ORDER BY updated_at DESC
  `).all();
}

export function deleteProject(id) {
  db.prepare('DELETE FROM chapter_memory WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM chapters WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export function upsertChapter(ch) {
  db.prepare(`
    INSERT INTO chapters (id, project_id, chapter_num, title, outline, content, summary, status)
    VALUES (@id, @project_id, @chapter_num, @title, @outline, @content, @summary, @status)
    ON CONFLICT(project_id, chapter_num) DO UPDATE SET
      title = excluded.title,
      outline = excluded.outline,
      content = excluded.content,
      summary = excluded.summary,
      status = excluded.status,
      updated_at = datetime('now')
  `).run(ch);
  return getChapter(ch.project_id, ch.chapter_num);
}

export function updateChapter(projectId, chapterNum, fields) {
  const allowed = ['title', 'outline', 'content', 'summary', 'status'];
  const sets = [];
  const params = { project_id: projectId, chapter_num: chapterNum };
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = @${k}`);
      params[k] = fields[k];
    }
  }
  if (!sets.length) return getChapter(projectId, chapterNum);
  sets.push(`updated_at = datetime('now')`);
  db.prepare(
    `UPDATE chapters SET ${sets.join(', ')} WHERE project_id = @project_id AND chapter_num = @chapter_num`
  ).run(params);
  return getChapter(projectId, chapterNum);
}

export function getChapter(projectId, chapterNum) {
  return db.prepare(
    'SELECT * FROM chapters WHERE project_id = ? AND chapter_num = ?'
  ).get(projectId, chapterNum);
}

export function listChapters(projectId) {
  return db.prepare(
    'SELECT * FROM chapters WHERE project_id = ? ORDER BY chapter_num ASC'
  ).all(projectId);
}

export function addMemory(m) {
  db.prepare(`
    INSERT INTO chapter_memory (id, project_id, chapter_num, memory_type, content)
    VALUES (@id, @project_id, @chapter_num, @memory_type, @content)
  `).run(m);
}

export function deleteChapterMemories(projectId, chapterNum) {
  db.prepare(
    'DELETE FROM chapter_memory WHERE project_id = ? AND chapter_num = ?'
  ).run(projectId, chapterNum);
}

export function deleteChaptersFrom(projectId, chapterNum) {
  db.prepare(
    'DELETE FROM chapters WHERE project_id = ? AND chapter_num >= ?'
  ).run(projectId, chapterNum);
}

export function deleteMemoriesFrom(projectId, chapterNum) {
  db.prepare(
    'DELETE FROM chapter_memory WHERE project_id = ? AND chapter_num >= ?'
  ).run(projectId, chapterNum);
}

export function replaceContinuation(projectId, startChapter, projectFields, chapters) {
  const replace = db.transaction(() => {
    deleteMemoriesFrom(projectId, startChapter);
    deleteChaptersFrom(projectId, startChapter);
    updateProject(projectId, projectFields);
    for (const chapter of chapters) upsertChapter(chapter);
  });
  replace();
  return getProject(projectId);
}

export function createGenerationJob(job) {
  db.prepare(`
    INSERT INTO generation_jobs (
      id, project_id, job_type, status, total_batches,
      completed_batches, current_batch, error, checkpoint_json
    ) VALUES (
      @id, @project_id, @job_type, @status, @total_batches,
      @completed_batches, @current_batch, @error, @checkpoint_json
    )
  `).run(job);
  return getGenerationJob(job.id);
}

export function updateGenerationJob(id, fields) {
  const allowed = [
    'status', 'total_batches', 'completed_batches', 'current_batch',
    'error', 'checkpoint_json',
  ];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = fields[key];
    }
  }
  if (!sets.length) return getGenerationJob(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE generation_jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getGenerationJob(id);
}

export function getGenerationJob(id) {
  return db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id);
}

export function getLatestGenerationJob(projectId, jobType = 'outline') {
  return db.prepare(`
    SELECT * FROM generation_jobs
    WHERE project_id = ? AND job_type = ?
    ORDER BY rowid DESC LIMIT 1
  `).get(projectId, jobType);
}

export function recoverInterruptedJobs() {
  db.prepare("UPDATE chapters SET status = 'pending' WHERE status = 'writing'").run();
  db.prepare("UPDATE chapters SET status = 'generated' WHERE status = 'summarizing'").run();
  db.prepare(`
    UPDATE generation_jobs
    SET status = 'failed',
        error = '服务重启导致任务中断，可从当前批次继续',
        updated_at = datetime('now')
    WHERE status = 'running'
  `).run();
  db.prepare(`
    UPDATE projects
    SET status = CASE
      WHEN EXISTS (
        SELECT 1 FROM generation_jobs
        WHERE generation_jobs.project_id = projects.id
          AND generation_jobs.job_type = 'outline'
          AND generation_jobs.status = 'failed'
      ) THEN 'planning_failed'
      ELSE 'draft'
    END
    WHERE status = 'planning'
  `).run();
  db.prepare(`
    UPDATE projects
    SET status = CASE
      WHEN EXISTS (
        SELECT 1 FROM chapters
        WHERE chapters.project_id = projects.id AND chapters.status = 'done'
      ) THEN 'writing'
      ELSE 'ready'
    END
    WHERE status = 'replanning'
  `).run();
}

export function getMemories(projectId, upToChapter = null) {
  if (upToChapter != null) {
    return db.prepare(
      `SELECT * FROM chapter_memory WHERE project_id = ? AND chapter_num <= ? ORDER BY chapter_num, created_at`
    ).all(projectId, upToChapter);
  }
  return db.prepare(
    `SELECT * FROM chapter_memory WHERE project_id = ? ORDER BY chapter_num, created_at`
  ).all(projectId);
}

export function getRecentChapters(projectId, beforeNum, limit = 2) {
  return db.prepare(`
    SELECT * FROM chapters
    WHERE project_id = ? AND chapter_num < ? AND status = 'done'
    ORDER BY chapter_num DESC LIMIT ?
  `).all(projectId, beforeNum, limit);
}

export default db;
