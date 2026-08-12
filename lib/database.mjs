import mysql from 'mysql2/promise';
import { Storage } from '@google-cloud/storage';

const config = process.env.DATABASE_URL || {host:process.env.DB_HOST,port:Number(process.env.DB_PORT || 3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,socketPath:process.env.DB_SOCKET_PATH || undefined,waitForConnections:true,connectionLimit:5,dateStrings:true};
if (!process.env.DATABASE_URL && !process.env.DB_NAME) throw Error('请设置 DATABASE_URL，或设置 DB_NAME、DB_USER、DB_PASSWORD 与 DB_HOST/DB_SOCKET_PATH');
export const pool = mysql.createPool(config);
const storage = new Storage();
const mapPost = row => row && ({id:row.id,title:row.title,category:row.category,date:row.post_date,excerpt:row.excerpt,content:row.content,contentFormat:row.content_format,backgroundMusicId:row.background_music_id,published:Boolean(row.published),updatedAt:row.updated_at});

export async function initDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS media (id CHAR(36) PRIMARY KEY,kind ENUM('image','audio') NOT NULL,object_name VARCHAR(512) NOT NULL UNIQUE,original_name VARCHAR(255) NOT NULL,content_type VARCHAR(127) NOT NULL,byte_size BIGINT UNSIGNED NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,INDEX media_kind_created (kind,created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS posts (id VARCHAR(64) PRIMARY KEY,title VARCHAR(160) NOT NULL,category VARCHAR(30) NOT NULL,post_date DATE NOT NULL,excerpt VARCHAR(260) NOT NULL,content LONGTEXT NOT NULL,content_format ENUM('text','html') NOT NULL DEFAULT 'text',background_music_id CHAR(36) NULL,published BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,CONSTRAINT posts_background_music FOREIGN KEY (background_music_id) REFERENCES media(id) ON DELETE SET NULL,INDEX posts_published_date (published,post_date)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
export async function listPosts(includeDrafts=false) { const [rows] = await pool.execute(`SELECT * FROM posts ${includeDrafts ? '' : 'WHERE published = TRUE'} ORDER BY post_date DESC, updated_at DESC`); return rows.map(mapPost); }
export async function getPost(id) { const [rows] = await pool.execute('SELECT * FROM posts WHERE id = ? LIMIT 1',[id]); return mapPost(rows[0]); }
export async function savePost(post, exists=false) { const values=[post.title,post.category,post.date,post.excerpt,post.content,post.contentFormat,post.backgroundMusicId,post.published,post.id]; if (exists) await pool.execute('UPDATE posts SET title=?,category=?,post_date=?,excerpt=?,content=?,content_format=?,background_music_id=?,published=? WHERE id=?',values); else await pool.execute('INSERT INTO posts (title,category,post_date,excerpt,content,content_format,background_music_id,published,id) VALUES (?,?,?,?,?,?,?,?,?)',values); return getPost(post.id); }
export async function removePost(id) { const [result] = await pool.execute('DELETE FROM posts WHERE id=?',[id]); return result.affectedRows > 0; }
export async function getMedia(id) { const [rows] = await pool.execute('SELECT * FROM media WHERE id = ? LIMIT 1',[id]); return rows[0] && ({id:rows[0].id,kind:rows[0].kind,objectName:rows[0].object_name,originalName:rows[0].original_name,contentType:rows[0].content_type,byteSize:Number(rows[0].byte_size)}); }
export async function saveMedia(media) { await pool.execute('INSERT INTO media (id,kind,object_name,original_name,content_type,byte_size) VALUES (?,?,?,?,?,?)',[media.id,media.kind,media.objectName,media.originalName,media.contentType,media.byteSize]); return getMedia(media.id); }
export function mediaBucket() { if (!process.env.GCS_BUCKET) throw Error('请设置 GCS_BUCKET'); return storage.bucket(process.env.GCS_BUCKET); }
export async function closeDatabase() { await pool.end(); }
