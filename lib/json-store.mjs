import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { permalinkFor, slugify } from './html.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const postsFile = path.join(root, 'data/posts.json');
const commentsFile = path.join(root, 'data/comments.json');
let posts = [];
let comments = [];

const publishedOf = postId => comments.filter(item => item.postId === postId && (item.status || 'published') === 'published');

const mapPost = post => {
  const row = {...post, commentCount: publishedOf(post.id).length};
  row.permalink = row.permalink || permalinkFor(row);
  return row;
};

async function persist() {
  await fs.writeFile(postsFile, JSON.stringify(posts, null, 2) + '\n');
  await fs.writeFile(commentsFile, JSON.stringify(comments.map(({ipHash, ...rest}) => rest), null, 2) + '\n');
}

export async function initDatabase() {
  posts = JSON.parse(await fs.readFile(postsFile, 'utf8'));
  try { comments = JSON.parse(await fs.readFile(commentsFile, 'utf8')); } catch { comments = []; }
  comments = comments.map(item => ({...item, status: item.status || 'published'}));
}

export async function listPosts(includeDrafts = false) {
  return posts.filter(post => includeDrafts || post.published !== false).sort((left, right) => right.date.localeCompare(left.date) || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))).map(mapPost);
}

export async function getPost(id) {
  const post = posts.find(item => item.id === id);
  if (!post) return null;
  const row = mapPost(post);
  row.comments = await listComments(id);
  row.commentCount = row.comments.length;
  return row;
}

export async function findPost(ref) {
  const value = String(ref || '').trim();
  if (!value) return null;
  const decoded = decodeURIComponent(value);
  const found = posts.find(item => item.id === value || item.id === `wp-${value}` || item.slug === value || item.slug === decoded);
  return found ? getPost(found.id) : null;
}

export async function savePost(post, exists = false) {
  const slug = slugify(post.slug || post.title, post.id.slice(0, 8));
  const clash = posts.find(item => item.slug === slug && item.id !== post.id);
  const row = {...post, slug: clash ? `${slug}-${post.id.slice(-6)}` : slug, permalink: permalinkFor({...post, slug})};
  if (exists) posts = posts.map(item => item.id === post.id ? {...item, ...row} : item);
  else posts.unshift(row);
  await persist();
  return getPost(post.id);
}

export async function removePost(id) {
  const before = posts.length;
  posts = posts.filter(item => item.id !== id);
  comments = comments.filter(item => item.postId !== id);
  if (posts.length === before) return false;
  await persist();
  return true;
}

export async function listComments(postId, statuses = ['published']) {
  return comments.filter(item => item.postId === postId && statuses.includes(item.status || 'published'))
    .sort((left, right) => String(left.date).localeCompare(String(right.date)) || String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

export async function listReviewQueue() {
  const byId = new Map(posts.map(post => [post.id, post.title]));
  return comments
    .filter(item => item.status === 'pending')
    .sort((left, right) => String(left.createdAt || left.date).localeCompare(String(right.createdAt || right.date)))
    .map(({ipHash, ...item}) => ({...item, postTitle: byId.get(item.postId) || ''}));
}

export async function pendingCount() {
  return comments.filter(item => item.status === 'pending').length;
}

export async function countComments({status, ipHash, since, postId} = {}) {
  const sinceMs = since ? new Date(since).getTime() : 0;
  return comments.filter(item => {
    if (status && (item.status || 'published') !== status) return false;
    if (ipHash && item.ipHash !== ipHash) return false;
    if (postId && item.postId !== postId) return false;
    if (sinceMs && new Date(item.createdAt || item.date).getTime() < sinceMs) return false;
    return true;
  }).length;
}

export async function saveComment(comment) {
  const row = {
    id: comment.id,
    postId: comment.postId,
    author: comment.author,
    date: comment.date,
    content: comment.content,
    status: comment.status || 'published',
    ipHash: comment.ipHash || null,
    createdAt: comment.createdAt || new Date().toISOString()
  };
  comments = comments.filter(item => item.id !== row.id).concat(row);
  await persist();
  return row;
}

export async function setCommentStatus(id, status) {
  if (!['published', 'rejected'].includes(status)) throw Error('无效的审阅结果');
  const found = comments.find(item => item.id === id && item.status === 'pending');
  if (!found) return false;
  found.status = status;
  await persist();
  return true;
}

export async function getMedia() { return null; }
export async function saveMedia() { throw Error('JSON 预览模式不支持上传媒体，请配置 MySQL 与 GCS'); }
export function mediaBucket() { throw Error('JSON 预览模式不支持上传媒体，请配置 MySQL 与 GCS'); }
export async function closeDatabase() {}
