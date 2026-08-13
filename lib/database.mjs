import mysql from 'mysql2/promise';
import { Storage } from '@google-cloud/storage';
import { permalinkFor, slugify } from './html.mjs';

const config = process.env.DATABASE_URL || {host:process.env.DB_HOST,port:Number(process.env.DB_PORT || 3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,socketPath:process.env.DB_SOCKET_PATH || undefined,waitForConnections:true,connectionLimit:5,dateStrings:true};
if (!process.env.DATABASE_URL && !process.env.DB_NAME) throw Error('请设置 DATABASE_URL，或设置 DB_NAME、DB_USER、DB_PASSWORD 与 DB_HOST/DB_SOCKET_PATH');
export const pool = mysql.createPool(config);
const storage = new Storage();

async function ensureColumn(table, column, ddl) {
  const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  if (!rows.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
}

function mapPost(row, commentCount = 0) {
  if (!row) return null;
  const post = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    date: row.post_date,
    excerpt: row.excerpt,
    content: row.content,
    contentFormat: row.content_format,
    backgroundMusicId: row.background_music_id,
    published: Boolean(row.published),
    commentCount: Number(commentCount || row.comment_count || 0),
    updatedAt: row.updated_at
  };
  post.permalink = permalinkFor(post);
  return post;
}

export async function initDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS media (id CHAR(36) PRIMARY KEY,kind ENUM('image','audio') NOT NULL,object_name VARCHAR(191) NOT NULL UNIQUE,original_name VARCHAR(255) NOT NULL,content_type VARCHAR(127) NOT NULL,byte_size BIGINT UNSIGNED NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,INDEX media_kind_created (kind,created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS posts (id VARCHAR(64) PRIMARY KEY,title VARCHAR(160) NOT NULL,category VARCHAR(30) NOT NULL,post_date DATE NOT NULL,excerpt VARCHAR(260) NOT NULL,content LONGTEXT NOT NULL,content_format ENUM('text','html') NOT NULL DEFAULT 'text',background_music_id CHAR(36) NULL,published BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,CONSTRAINT posts_background_music FOREIGN KEY (background_music_id) REFERENCES media(id) ON DELETE SET NULL,INDEX posts_published_date (published,post_date)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await ensureColumn('posts', 'slug', 'slug VARCHAR(180) NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS comments (id VARCHAR(64) PRIMARY KEY,post_id VARCHAR(64) NOT NULL,author_name VARCHAR(80) NOT NULL,body LONGTEXT NOT NULL,comment_date DATE NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,INDEX comments_post_date (post_id, comment_date),CONSTRAINT comments_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await ensureColumn('comments', 'status', `status ENUM('pending','published','rejected') NOT NULL DEFAULT 'published'`);
  await ensureColumn('comments', 'ip_hash', 'ip_hash CHAR(64) NULL');
  try { await pool.query('CREATE INDEX comments_status_created ON comments (status, created_at)'); } catch { /* exists */ }
  try { await pool.query('CREATE INDEX comments_ip_created ON comments (ip_hash, created_at)'); } catch { /* exists */ }
  try { await pool.query('CREATE UNIQUE INDEX posts_slug ON posts (slug)'); } catch { /* already exists or nulls */ }
}

async function commentCounts(ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.execute(`SELECT post_id, COUNT(*) AS total FROM comments WHERE status = 'published' AND post_id IN (${placeholders}) GROUP BY post_id`, ids);
  return new Map(rows.map(row => [row.post_id, Number(row.total)]));
}

export async function listPosts(includeDrafts=false) {
  const [rows] = await pool.execute(`SELECT * FROM posts ${includeDrafts ? '' : 'WHERE published = TRUE'} ORDER BY post_date DESC, updated_at DESC`);
  const counts = await commentCounts(rows.map(row => row.id));
  return rows.map(row => mapPost(row, counts.get(row.id) || 0));
}

export async function getPost(id) {
  const [rows] = await pool.execute('SELECT * FROM posts WHERE id = ? LIMIT 1', [id]);
  const post = mapPost(rows[0]);
  if (!post) return null;
  post.comments = await listComments(post.id);
  post.commentCount = post.comments.length;
  return post;
}

export async function findPost(ref) {
  const value = String(ref || '').trim();
  if (!value) return null;
  const byId = await getPost(value);
  if (byId) return byId;
  if (/^\d+$/.test(value)) return getPost(`wp-${value}`);
  const slug = decodeURIComponent(value);
  const [rows] = await pool.execute('SELECT * FROM posts WHERE slug = ? LIMIT 1', [slug]);
  if (!rows[0]) return null;
  return getPost(rows[0].id);
}

async function uniqueSlug(slug, id) {
  const base = slugify(slug, id.slice(0, 8));
  const [rows] = await pool.execute('SELECT id FROM posts WHERE slug = ? AND id != ? LIMIT 1', [base, id]);
  return rows.length ? `${base}-${id.replace(/[^a-z0-9]/gi, '').slice(-8)}` : base;
}

export async function savePost(post, exists=false) {
  const slug = await uniqueSlug(post.slug || post.title, post.id);
  const values = [post.title, post.category, post.date, post.excerpt, post.content, post.contentFormat, post.backgroundMusicId, post.published, slug, post.id];
  if (exists) await pool.execute('UPDATE posts SET title=?,category=?,post_date=?,excerpt=?,content=?,content_format=?,background_music_id=?,published=?,slug=? WHERE id=?', values);
  else await pool.execute('INSERT INTO posts (title,category,post_date,excerpt,content,content_format,background_music_id,published,slug,id) VALUES (?,?,?,?,?,?,?,?,?,?)', values);
  return getPost(post.id);
}

export async function removePost(id) {
  const [result] = await pool.execute('DELETE FROM posts WHERE id=?', [id]);
  return result.affectedRows > 0;
}

function mapComment(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    postId: row.post_id,
    author: row.author_name,
    date: row.comment_date,
    content: row.body,
    status: row.status || 'published',
    createdAt: row.created_at,
    ...extra
  };
}

export async function listComments(postId, statuses = ['published']) {
  const placeholders = statuses.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT id, post_id, author_name, body, comment_date, status, created_at FROM comments WHERE post_id = ? AND status IN (${placeholders}) ORDER BY comment_date ASC, created_at ASC`,
    [postId, ...statuses]
  );
  return rows.map(row => mapComment(row));
}

export async function listReviewQueue() {
  const [rows] = await pool.execute(
    `SELECT c.id, c.post_id, c.author_name, c.body, c.comment_date, c.status, c.created_at, p.title AS post_title
     FROM comments c LEFT JOIN posts p ON p.id = c.post_id
     WHERE c.status = 'pending' ORDER BY c.created_at ASC LIMIT 80`
  );
  return rows.map(row => mapComment(row, {postTitle: row.post_title || ''}));
}

export async function pendingCount() {
  const [rows] = await pool.execute(`SELECT COUNT(*) AS total FROM comments WHERE status = 'pending'`);
  return Number(rows[0].total);
}

export async function countComments({status, ipHash, since, postId} = {}) {
  const where = [];
  const values = [];
  if (status) { where.push('status = ?'); values.push(status); }
  if (ipHash) { where.push('ip_hash = ?'); values.push(ipHash); }
  if (postId) { where.push('post_id = ?'); values.push(postId); }
  if (since) { where.push('created_at >= ?'); values.push(since); }
  const sql = `SELECT COUNT(*) AS total FROM comments${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const [rows] = await pool.execute(sql, values);
  return Number(rows[0].total);
}

export async function saveComment(comment) {
  await pool.execute(
    'INSERT INTO comments (id,post_id,author_name,body,comment_date,status,ip_hash) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE author_name=VALUES(author_name), body=VALUES(body), comment_date=VALUES(comment_date), status=VALUES(status)',
    [comment.id, comment.postId, comment.author, comment.content, comment.date, comment.status || 'published', comment.ipHash || null]
  );
  return comment;
}

export async function setCommentStatus(id, status) {
  if (!['published', 'rejected'].includes(status)) throw Error('无效的审阅结果');
  const [result] = await pool.execute('UPDATE comments SET status = ? WHERE id = ? AND status = ?', [status, id, 'pending']);
  return result.affectedRows > 0;
}

export async function getMedia(id) {
  const [rows] = await pool.execute('SELECT * FROM media WHERE id = ? LIMIT 1', [id]);
  return rows[0] && ({id:rows[0].id,kind:rows[0].kind,objectName:rows[0].object_name,originalName:rows[0].original_name,contentType:rows[0].content_type,byteSize:Number(rows[0].byte_size)});
}

export async function saveMedia(media) {
  await pool.execute('INSERT INTO media (id,kind,object_name,original_name,content_type,byte_size) VALUES (?,?,?,?,?,?)', [media.id,media.kind,media.objectName,media.originalName,media.contentType,media.byteSize]);
  return getMedia(media.id);
}

export function mediaBucket() {
  if (!process.env.GCS_BUCKET) throw Error('请设置 GCS_BUCKET');
  return storage.bucket(process.env.GCS_BUCKET);
}

export async function closeDatabase() {
  await pool.end();
}
