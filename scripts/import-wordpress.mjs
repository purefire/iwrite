import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { excerptFrom, permalinkFor, plainText, sanitizeHtml, slugFromWordpress } from '../lib/html.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = (process.argv[2] || 'https://jing.lv').replace(/\/$/, '');

async function request(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`${response.status} ${response.statusText}: ${url}`);
  return response;
}

async function collect(resource) {
  const first = await request(`${origin}/wp-json/wp/v2/${resource}?per_page=100&page=1`);
  const pages = Number(first.headers.get('x-wp-totalpages') || 1);
  const all = [await first.json()];
  for (let page = 2; page <= pages; page += 1) {
    all.push(await (await request(`${origin}/wp-json/wp/v2/${resource}?per_page=100&page=${page}`)).json());
  }
  return all.flat();
}

const [categoryRows, postRows, commentRows] = await Promise.all([
  collect('categories'),
  collect('posts'),
  collect('comments')
]);
const categories = new Map(categoryRows.map(item => [item.id, item.name]));
const posts = postRows.map(post => {
  const content = sanitizeHtml(post.content?.rendered);
  const title = plainText(post.title?.rendered);
  const slug = slugFromWordpress(post);
  const date = String(post.date || '').slice(0, 10);
  return {
    id: `wp-${post.id}`,
    wpId: post.id,
    slug,
    title,
    category: categories.get(post.categories?.[0]) || '未分类',
    date,
    excerpt: excerptFrom(content, post.excerpt?.rendered),
    content,
    contentFormat: 'html',
    permalink: permalinkFor({date, slug, id: `wp-${post.id}`, title}),
    published: post.status === 'publish',
    updatedAt: post.modified_gmt ? `${post.modified_gmt.replace(' ', 'T')}Z` : new Date().toISOString()
  };
}).filter(post => post.title && plainText(post.content));

const comments = commentRows.filter(item => item.status === 'approved').map(item => ({
  id: `wp-c-${item.id}`,
  postId: `wp-${item.post}`,
  author: plainText(item.author_name).slice(0, 80) || '访客',
  date: String(item.date || '').slice(0, 10),
  content: sanitizeHtml(item.content?.rendered, 4000),
  status: 'published'
})).filter(item => item.content && posts.some(post => post.id === item.postId));

await fs.mkdir(path.join(root, 'data'), {recursive: true});
await fs.writeFile(path.join(root, 'data/posts.json'), JSON.stringify(posts, null, 2) + '\n');
await fs.writeFile(path.join(root, 'data/comments.json'), JSON.stringify(comments, null, 2) + '\n');
const verse = posts.filter(post => post.category === '诗囊' || post.category === '新春贺辞').length;
const images = posts.filter(post => /<img /i.test(post.content)).length;
const adsLeft = posts.filter(post => /adsbygoogle/i.test(post.content)).length;
console.log(`已从 ${origin} 导入 ${posts.length} 篇文章、${comments.length} 条评论。诗文/贺辞 ${verse} 篇，含图片 ${images} 篇，残留广告代码 ${adsLeft} 篇。`);
