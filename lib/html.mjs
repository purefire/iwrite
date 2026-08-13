const allowedTags = new Set(['p','br','strong','b','em','i','u','h2','h3','blockquote','ul','ol','li','a','code','pre','hr','img']);
const forbidden = 'script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|ins';

export const clean = (value, limit) => String(value ?? '').trim().slice(0, limit);
export const escapeAttribute = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const attribute = (source, name) => source.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'))?.slice(1).find(value => value !== undefined) || '';

export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&hellip;/gi, '…')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

export function plainText(value) {
  return decodeEntities(String(value ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h2|h3|li|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]+/g, ' ')
    .trim());
}

export function slugify(title, fallback = 'entry') {
  const slug = decodeEntities(String(title || ''))
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

export function permalinkFor(post) {
  const date = String(post.date || '').slice(0, 10);
  const slug = post.slug || slugify(post.title, post.id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `/?post=${encodeURIComponent(post.id)}`;
  return `/blog/${date.replaceAll('-', '/')}/${encodeURIComponent(slug)}/`;
}

export function safeHref(raw) {
  const value = String(raw || '').trim();
  if (!value || value.startsWith('#') || value.startsWith('/')) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : '';
  } catch {
    return '';
  }
}

export function safeImageSrc(raw) {
  const value = String(raw || '').trim();
  if (/^\/media\/[0-9a-f-]{36}$/i.test(value)) return value;
  if (/^\/wp-content\/uploads\//i.test(value)) return `https://jing.lv${value}`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (!['jing.lv', 'www.jing.lv'].includes(url.hostname)) return '';
    if (!url.pathname.startsWith('/wp-content/')) return '';
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return '';
  }
}

function indentClass(attributes) {
  const named = attribute(attributes, 'class');
  if (/\bindent-2\b/.test(named)) return 'indent-2';
  if (/\bindent-1\b/.test(named)) return 'indent-1';
  const padding = Number((attribute(attributes, 'style').match(/padding-left\s*:\s*(\d+)/i) || [])[1] || 0);
  if (padding >= 70) return 'indent-2';
  if (padding >= 30) return 'indent-1';
  return '';
}

export function wordpressHtml(html) {
  return decodeEntities(String(html || ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/\(adsbygoogle\s*=\s*window\.adsbygoogle[\s\S]*?\)\.push\(\{\}\);/g, '')
    .replace(/<ins\b[\s\S]*?<\/ins>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h4(\s[^>]*)?>/gi, '<h3$1>')
    .replace(/<\/h4>/gi, '</h3>')
    .replace(/<\/?(span|font|section|article|figure|figcaption)[^>]*>/gi, '')
    .replace(/<div([^>]*)>/gi, (_, attrs) => {
      const indent = indentClass(attrs);
      return indent ? `<p class="${indent}">` : '<p>';
    })
    .replace(/<\/div>/gi, '</p>')
    .replace(/<p>\s*<\/p>/gi, '')
    .replace(/(<p[^>]*>)\s*<p>/gi, '$1')
    .replace(/<\/p>\s*<\/p>/gi, '</p>');
}

export function sanitizeHtml(value, limit = 200000) {
  return wordpressHtml(String(value ?? '').slice(0, limit)).replace(
    new RegExp(`<\\s*(${forbidden})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, 'gi'),
    ''
  ).replace(/<\s*(\/?)\s*([a-z0-9]+)([^>]*)>/gi, (_, closing, name, attributes) => {
    const tag = name.toLowerCase();
    if (!allowedTags.has(tag)) return '';
    if (closing) return tag === 'img' ? '' : `</${tag}>`;
    if (tag === 'img') {
      const src = safeImageSrc(attribute(attributes, 'src'));
      const alt = clean(decodeEntities(attribute(attributes, 'alt')), 180);
      return src ? `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" loading="lazy">` : '';
    }
    if (tag === 'br') return '<br>';
    if (tag === 'hr') return '<hr>';
    if (tag === 'p') {
      const indent = indentClass(attributes);
      return indent ? `<p class="${indent}">` : '<p>';
    }
    if (tag !== 'a') return `<${tag}>`;
    const href = safeHref(attribute(attributes, 'href'));
    return href ? `<a href="${escapeAttribute(href)}" rel="noopener noreferrer">` : '<a>';
  }).replace(/<p>\s*<\/p>/gi, '').replace(/<p>\s*$/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function excerptFrom(content, requested = '') {
  const requestedText = plainText(requested).replace(/…+$/g, '').trim();
  const source = requestedText.length > 12 ? requestedText : plainText(content);
  return source.slice(0, 160);
}

export function verseKind(post) {
  const category = post.category || '';
  const text = plainText(post.content);
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const named = category === '诗囊' || category === '新春贺辞';
  if (!lines.length) return named ? 'classical' : '';
  const short = lines.filter(line => line.length <= 22).length / lines.length;
  const classicalLen = lines.filter(line => line.length >= 5 && line.length <= 16).length / lines.length;
  if (!named && short < 0.7) return '';
  return classicalLen >= 0.55 ? 'classical' : 'modern';
}

export function slugFromWordpress(post) {
  try {
    const url = new URL(post.link);
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    const last = decodeURIComponent(parts.at(-1) || '');
    if (last && last !== String(post.id)) return slugify(decodeEntities(last), `wp-${post.id}`);
  } catch { /* use title */ }
  return slugify(decodeEntities(post.title?.rendered || post.title), `wp-${post.id}`);
}
