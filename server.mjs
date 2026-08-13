import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';
import { clean, escapeAttribute, excerptFrom, permalinkFor, plainText, sanitizeHtml, slugify } from './lib/html.mjs';
import { extractiveAnswer, searchPosts, streamGemini } from './lib/retrieve.mjs';
import { NOTE_LIMITS, isHoneypot, parseNote, sameOrigin } from './lib/notes.mjs';

const jsonMode = process.env.ARCHIVE_JSON === '1' || (process.env.NODE_ENV !== 'production' && !process.env.DB_NAME && !process.env.DATABASE_URL);
const {
  countComments, findPost, getMedia, initDatabase, listComments, listPosts, listReviewQueue,
  mediaBucket, pendingCount, removePost, saveComment, saveMedia, savePost, setCommentStatus
} = await import(jsonMode ? './lib/json-store.mjs' : './lib/database.mjs');

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 4173);
const password = process.env.ADMIN_PASSWORD;
const geminiKey = process.env.GEMINI_API_KEY || '';
const siteOrigin = (process.env.SITE_ORIGIN || 'https://jing.lv').replace(/\/$/, '');
const sessions = new Map();
const askHits = new Map();
const noteBurst = new Map();
const commentSecret = process.env.COMMENT_SECRET || password || 'jing-lv-local-note';
const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.xml':'application/xml; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const imageTypes = new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['image/gif','gif']]);
const audioTypes = new Map([['audio/mpeg','mp3'],['audio/mp3','mp3'],['audio/ogg','ogg'],['audio/wav','wav']]);
const spaPaths = pathname => pathname === '/' || pathname === '/about' || pathname === '/archive' || pathname === '/sample-page' || /^\/blog\/(category|author)\//.test(pathname) || /^\/blog\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/.test(pathname);

const security = {'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'SAMEORIGIN'};
const send = (res, status, payload, headers = {}) => res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...security, ...headers}).end(JSON.stringify(payload));
const cookie = req => req.headers.cookie?.match(/jing_session=([^;]+)/)?.[1];
const xml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const clientIp = req => String(req.headers['x-real-ip'] || '').trim() || String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || 'local';

function isAdmin(req) {
  const token = cookie(req), expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) { sessions.delete(token); return false; }
  return true;
}

function rateLimit(key, limit = 30, windowMs = 3600000) {
  const now = Date.now();
  const hits = (askHits.get(key) || []).filter(time => now - time < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  askHits.set(key, hits);
  return true;
}

function postFrom(input, old = {}) {
  const title = clean(input.title, 160);
  const contentFormat = input.contentFormat === 'html' ? 'html' : 'text';
  const content = contentFormat === 'html' ? sanitizeHtml(input.content) : clean(input.content, 200000);
  if (!title || !plainText(content)) throw Error('标题和正文不能为空');
  const id = old.id || crypto.randomUUID();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : new Date().toISOString().slice(0, 10);
  const slug = slugify(input.slug || old.slug || title, id.slice(0, 8));
  const excerpt = clean(input.excerpt, 260) || excerptFrom(content);
  return {
    id, title, slug, category: clean(input.category, 30) || '未分类', date, excerpt, content, contentFormat,
    backgroundMusicId: clean(input.backgroundMusicId, 36) || null,
    published: input.published !== false
  };
}

const body = (req, max = 1e6) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; if (raw.length > max) reject(Error('请求内容过大')); });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Error('无效 JSON')); } });
  req.on('error', reject);
});

function ipHash(ip) {
  return crypto.createHmac('sha256', commentSecret).update(String(ip)).digest('hex');
}

function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function publicComments(comments) {
  return (comments || []).map(item => ({id: item.id, author: item.author, date: item.date, content: item.content}));
}

function deskNotes(comments) {
  return (comments || []).map(item => ({
    id: item.id, postId: item.postId, postTitle: item.postTitle || '', author: item.author, date: item.date, content: item.content
  }));
}

function rememberBurst(hash) {
  const now = Date.now();
  if (noteBurst.size > 2000) {
    for (const [key, time] of noteBurst) if (now - time > NOTE_LIMITS.perIpCooldownMs) noteBurst.delete(key);
  }
  noteBurst.set(hash, now);
}

async function receiveNote(req, res) {
  if (!sameOrigin(req)) return send(res, 403, {error:'请从本站页面留言'});
  if (!rateLimit(`note:${clientIp(req)}`, NOTE_LIMITS.perIpHour, 3600000) || !rateLimit('note:global', NOTE_LIMITS.globalHour, 3600000) || !rateLimit('note:global:day', NOTE_LIMITS.globalDay, 86400000)) {
    return send(res, 429, {error:'此刻案头已满，请稍后再留'});
  }
  const hash = ipHash(clientIp(req));
  const last = noteBurst.get(hash) || 0;
  if (Date.now() - last < NOTE_LIMITS.perIpCooldownMs) return send(res, 429, {error:'请稍后再留一行'});
  const input = await body(req, 4096);
  rememberBurst(hash);
  if (isHoneypot(input)) return send(res, 202, {ok:true});
  const note = parseNote(input);
  const post = await findPost(clean(input.postId, 64));
  if (!post || !post.published) return send(res, 404, {error:'文章不存在'});
  const [pending, total, ipHour, ipDay, globalDay, pendingHere, publishedHere] = await Promise.all([
    countComments({status:'pending'}),
    countComments(),
    countComments({ipHash: hash, since: ago(3600000)}),
    countComments({ipHash: hash, since: ago(86400000)}),
    countComments({since: ago(86400000)}),
    countComments({status:'pending', postId: post.id}),
    countComments({status:'published', postId: post.id})
  ]);
  if (pending >= NOTE_LIMITS.maxPending || total >= NOTE_LIMITS.maxTotal || ipHour >= NOTE_LIMITS.perIpHour || ipDay >= NOTE_LIMITS.perIpDay || globalDay >= NOTE_LIMITS.globalDay || pendingHere >= NOTE_LIMITS.maxPendingPerPost || publishedHere >= NOTE_LIMITS.maxPublishedPerPost) {
    return send(res, 429, {error:'此刻案头已满，请稍后再留'});
  }
  await saveComment({
    id: crypto.randomUUID(),
    postId: post.id,
    author: note.author,
    content: note.content,
    date: new Date().toISOString().slice(0, 10),
    status: 'pending',
    ipHash: hash
  });
  return send(res, 202, {ok:true});
}

async function verifyBackgroundMusic(id) {
  if (!id) return;
  const media = await getMedia(id);
  if (!media || media.kind !== 'audio') throw Error('所选配乐不存在或不是音频文件');
}

function receiveUpload(req) {
  return new Promise((resolve, reject) => {
    let fields = {}, uploaded = false, settled = false, pending, result;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    const busboy = Busboy({headers: req.headers, limits:{files:1, fileSize:20*1024*1024, fields:4}});
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (field, file, info) => {
      if (uploaded) { file.resume(); return fail(Error('一次只能上传一个文件')); }
      uploaded = true;
      const kind = fields.kind, types = kind === 'image' ? imageTypes : kind === 'audio' ? audioTypes : null, extension = types?.get(info.mimeType);
      if (field !== 'file' || !extension) { file.resume(); return fail(Error(kind ? '不支持的文件格式' : '缺少媒体类型')); }
      const maxBytes = kind === 'image' ? 8*1024*1024 : 20*1024*1024;
      const id = crypto.randomUUID(), objectName = `media/${kind}/${id}.${extension}`, target = mediaBucket().file(objectName);
      const output = target.createWriteStream({resumable:false, metadata:{contentType:info.mimeType, cacheControl:'public, max-age=31536000, immutable'}});
      let byteSize = 0, limited = false;
      file.on('data', chunk => { byteSize += chunk.length; result.byteSize = byteSize; });
      file.on('limit', () => { limited = true; output.destroy(Error(`文件不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`)); });
      pending = new Promise((done, failed) => { output.on('finish', done); output.on('error', failed); });
      file.pipe(output);
      result = {id, kind, objectName, originalName: clean(info.filename || 'upload', 255), contentType: info.mimeType, byteSize, bucket: target, limited, maxBytes};
    });
    busboy.on('error', fail);
    busboy.on('finish', async () => {
      if (settled) return;
      if (!uploaded || !pending) return fail(Error('请选择一个文件'));
      try {
        await pending;
        if (result.limited || result.byteSize > result.maxBytes) return fail(Error(`文件不能超过 ${Math.round(result.maxBytes / 1024 / 1024)}MB`));
        settled = true; resolve(result);
      } catch (error) { fail(error); }
    });
    req.pipe(busboy);
  });
}

async function serveMedia(res, id) {
  const media = await getMedia(id);
  if (!media) return res.writeHead(404).end('Not found');
  const stream = mediaBucket().file(media.objectName).createReadStream();
  stream.once('error', () => { if (!res.headersSent) res.writeHead(404).end('Not found'); else res.destroy(); });
  res.writeHead(200, {'Content-Type': media.contentType, 'Content-Length': media.byteSize, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline'});
  stream.pipe(res);
}

function rssFeed(posts) {
  const items = posts.slice(0, 20).map(post => `    <item>
      <title>${xml(post.title)}</title>
      <link>${xml(siteOrigin + (post.permalink || permalinkFor(post)))}</link>
      <guid isPermaLink="false">${xml(post.id)}</guid>
      <pubDate>${xml(new Date(`${post.date}T00:00:00Z`).toUTCString())}</pubDate>
      <category>${xml(post.category)}</category>
      <description>${xml(post.excerpt || excerptFrom(post.content))}</description>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>JING.LV</title>
    <link>${xml(siteOrigin)}</link>
    <description>私人档案 · 诗文、私记、技术与旅途</description>
    <language>zh-CN</language>
${items}
  </channel>
</rss>
`;
}

function sitemap(posts) {
  const urls = [`${siteOrigin}/`, `${siteOrigin}/about`, ...posts.map(post => siteOrigin + (post.permalink || permalinkFor(post)))];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url><loc>${xml(url)}</loc></url>`).join('\n')}
</urlset>
`;
}

function injectMeta(html, post) {
  const title = `${post.title} — JING.LV`;
  const description = escapeAttribute((post.excerpt || excerptFrom(post.content)).slice(0, 160));
  const url = siteOrigin + (post.permalink || permalinkFor(post));
  const tags = `
  <title>${escapeAttribute(title)}</title>
  <meta name="description" content="${description}" />
  <link rel="canonical" href="${escapeAttribute(url)}" />
  <meta property="og:title" content="${escapeAttribute(post.title)}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${escapeAttribute(url)}" />
  <meta property="og:type" content="article" />`;
  return html
    .replace(/<link rel="canonical"[^>]*>/, '')
    .replace('<title>JING.LV — 私人档案</title>', tags);
}

async function serveApp(res, pathname) {
  let html = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
  const match = pathname.match(/^\/blog\/\d{4}\/\d{2}\/\d{2}\/([^/]+)\/?$/);
  if (match) {
    const post = await findPost(decodeURIComponent(match[1]));
    if (post?.published) html = injectMeta(html, post);
  } else if (pathname === '/about' || pathname === '/sample-page') {
    html = html.replace('<title>JING.LV — 私人档案</title>', '<title>About — JING.LV</title>');
  }
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', ...security}).end(html);
}

async function askArchive(req, res) {
  if (!rateLimit(clientIp(req))) return send(res, 429, {error:'询问过于频繁，请稍后再试'});
  const input = await body(req);
  const question = clean(input.question, 240);
  if (question.length < 2) return send(res, 400, {error:'请输入想检索的问题'});
  const hits = searchPosts(await listPosts(false), question, 5);
  res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache', 'Connection':'keep-alive'});
  res.write(`data: ${JSON.stringify({hits, mode: geminiKey ? 'model' : 'retrieve'})}\n\n`);
  try {
    if (geminiKey) {
      await streamGemini({
        question, hits, apiKey: geminiKey,
        onToken: token => res.write(`data: ${JSON.stringify({token})}\n\n`)
      });
    } else {
      res.write(`data: ${JSON.stringify({token: extractiveAnswer(question, hits)})}\n\n`);
    }
  } catch (error) {
    res.write(`data: ${JSON.stringify({token: extractiveAnswer(question, hits) + '\n\n（生成模型暂不可用，以上为档案原文检索。）'})}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

async function api(req, res, pathname) {
  try {
    const admin = isAdmin(req);
    const postMatch = pathname.match(/^\/api\/posts\/([^/]+)$/);
    const mediaMatch = pathname.match(/^\/api\/media\/([^/]+)$/);
    if (req.method === 'GET' && pathname === '/api/posts') return send(res, 200, await listPosts(admin));
    if (req.method === 'GET' && pathname === '/api/search') {
      const query = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
      return send(res, 200, searchPosts(await listPosts(admin), query, 12));
    }
    if (req.method === 'POST' && pathname === '/api/ask') return await askArchive(req, res);
    if (req.method === 'POST' && pathname === '/api/comments') return await receiveNote(req, res);
    if (req.method === 'GET' && postMatch) {
      const post = await findPost(decodeURIComponent(postMatch[1]));
      if (!post || (!post.published && !admin)) return send(res, 404, {error:'文章不存在'});
      post.comments = publicComments(post.comments);
      if (admin) post.pendingNotes = publicComments(await listComments(post.id, ['pending']));
      return send(res, 200, post);
    }
    if (req.method === 'GET' && mediaMatch) {
      const media = await getMedia(mediaMatch[1]);
      return media ? send(res, 200, media) : send(res, 404, {error:'媒体不存在'});
    }
    if (req.method === 'GET' && pathname === '/api/me') {
      return send(res, 200, {authenticated: admin, configured: Boolean(password), oracle: Boolean(geminiKey), pendingNotes: admin ? await pendingCount() : 0});
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      if (!password) return send(res, 503, {error:'服务器尚未设置 ADMIN_PASSWORD'});
      const input = await body(req);
      const supplied = Buffer.from(clean(input.password, 256).padEnd(256));
      const expected = Buffer.from(password.slice(0, 256).padEnd(256));
      if (!crypto.timingSafeEqual(supplied, expected)) return send(res, 401, {error:'密码不正确'});
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + 864e5);
      return send(res, 200, {ok:true}, {'Set-Cookie':`jing_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secureCookie}`});
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      sessions.delete(cookie(req));
      return send(res, 200, {ok:true}, {'Set-Cookie':`jing_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`});
    }
    if (!admin) return send(res, 401, {error:'请先登录'});
    if (req.method === 'GET' && pathname === '/api/comments') return send(res, 200, deskNotes(await listReviewQueue()));
    const commentMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
    if (req.method === 'POST' && commentMatch) {
      const input = await body(req, 4096);
      const status = input.action === 'reject' ? 'rejected' : input.action === 'publish' ? 'published' : '';
      if (!status) throw Error('请选择收下或放下');
      return await setCommentStatus(commentMatch[1], status) ? send(res, 200, {ok:true, pendingNotes: await pendingCount()}) : send(res, 404, {error:'没有这条待审留言'});
    }
    if (req.method === 'POST' && pathname === '/api/media') {
      const upload = await receiveUpload(req);
      try { return send(res, 201, await saveMedia(upload)); }
      catch (error) { await upload.bucket.delete({ignoreNotFound:true}); throw error; }
    }
    if (req.method === 'POST' && pathname === '/api/posts') {
      const post = postFrom(await body(req));
      await verifyBackgroundMusic(post.backgroundMusicId);
      return send(res, 201, await savePost(post));
    }
    if (req.method === 'PUT' && postMatch) {
      const old = await findPost(decodeURIComponent(postMatch[1]));
      if (!old) return send(res, 404, {error:'文章不存在'});
      const post = postFrom(await body(req), old);
      await verifyBackgroundMusic(post.backgroundMusicId);
      return send(res, 200, await savePost(post, true));
    }
    if (req.method === 'DELETE' && postMatch) {
      const old = await findPost(decodeURIComponent(postMatch[1]));
      return old && await removePost(old.id) ? send(res, 200, {ok:true}) : send(res, 404, {error:'文章不存在'});
    }
    return send(res, 404, {error:'接口不存在'});
  } catch (error) {
    return send(res, 400, {error: error.message || '请求失败'});
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname.startsWith('/api/')) return await api(req, res, pathname);
  if (pathname === '/feed' || pathname === '/rss.xml') {
    res.writeHead(200, {'Content-Type':'application/rss+xml; charset=utf-8', 'Cache-Control':'public, max-age=600'}).end(rssFeed(await listPosts(false)));
    return;
  }
  if (pathname === '/sitemap.xml') {
    res.writeHead(200, {'Content-Type':'application/xml; charset=utf-8', 'Cache-Control':'public, max-age=600'}).end(sitemap(await listPosts(false)));
    return;
  }
  const mediaMatch = pathname.match(/^\/media\/([^/]+)$/);
  if (mediaMatch) {
    try { return await serveMedia(res, mediaMatch[1]); }
    catch { return res.writeHead(404).end('Not found'); }
  }
  if (spaPaths(pathname) || url.searchParams.has('p') || url.searchParams.has('post')) return serveApp(res, pathname);
  const file = pathname.slice(1);
  const target = path.resolve(publicDir, file);
  if (!target.startsWith(publicDir)) return res.writeHead(403).end();
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': path.extname(target) === '.js' || path.extname(target) === '.css' ? 'no-store' : 'public, max-age=86400'}).end(data);
  } catch {
    if (url.searchParams.has('p') || url.searchParams.has('post')) return serveApp(res, '/');
    res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}).end('Not found');
  }
});

initDatabase().then(() => server.listen(port, '127.0.0.1', () => console.log(`jing.lv is running at http://127.0.0.1:${port}`))).catch(error => {
  console.error(`数据库初始化失败：${error.message}`);
  process.exitCode = 1;
});
