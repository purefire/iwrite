import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = (process.argv[2] || 'https://jing.lv').replace(/\/$/, '');
const strip = html => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#821[67];/g, '"').replace(/&#821[12];/g, '’').replace(/\n{3,}/g, '\n\n').trim();
async function request(url) { const response = await fetch(url); if (!response.ok) throw Error(`${response.status} ${response.statusText}: ${url}`); return response; }
const categories = new Map((await (await request(`${origin}/wp-json/wp/v2/categories?per_page=100`)).json()).map(item => [item.id, item.name]));
const first = await request(`${origin}/wp-json/wp/v2/posts?per_page=100&page=1`);
const pages = Number(first.headers.get('x-wp-totalpages') || 1), all = [await first.json()];
for (let page = 2; page <= pages; page += 1) all.push(await (await request(`${origin}/wp-json/wp/v2/posts?per_page=100&page=${page}`)).json());
const posts = all.flat().map(post => { const content = strip(post.content?.rendered); return {id:`wp-${post.id}`,title:strip(post.title?.rendered),category:categories.get(post.categories?.[0]) || '未分类',date:post.date.slice(0,10),excerpt:strip(post.excerpt?.rendered).slice(0,260) || content.slice(0,90),content,published:post.status === 'publish',updatedAt:post.modified_gmt ? `${post.modified_gmt.replace(' ','T')}Z` : new Date().toISOString()}; }).filter(post => post.title && post.content);
await fs.writeFile(path.join(root, 'data/posts.json'), JSON.stringify(posts, null, 2) + '\n');
console.log(`已从 ${origin} 导入 ${posts.length} 篇文章。`);
