import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, getPost, initDatabase, saveComment, savePost } from '../lib/database.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = process.argv[2] || path.join(root, 'data/posts.json');
const commentSource = path.join(path.dirname(source), 'comments.json');
const posts = JSON.parse(await fs.readFile(source, 'utf8'));
await initDatabase();
for (const post of posts) {
  const row = {
    id: post.id,
    slug: post.slug,
    title: post.title,
    category: post.category || '未分类',
    date: post.date,
    excerpt: post.excerpt || '',
    content: post.content,
    contentFormat: post.contentFormat === 'html' ? 'html' : 'text',
    backgroundMusicId: null,
    published: post.published !== false
  };
  await savePost(row, Boolean(await getPost(row.id)));
}
let comments = [];
try { comments = JSON.parse(await fs.readFile(commentSource, 'utf8')); } catch { comments = []; }
for (const comment of comments) {
  if (await getPost(comment.postId)) await saveComment({...comment, status: comment.status || 'published'});
}
await closeDatabase();
console.log(`已导入 ${posts.length} 篇文章、${comments.length} 条评论至 MySQL。`);
