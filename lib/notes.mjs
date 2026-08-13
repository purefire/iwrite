const URL_LIKE = /https?:\/\/|www\.|\/\/|javascript:|data:|<\s*\/?\s*[a-z]|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/i;
const FORBIDDEN = /[<>{}]/;

export const NOTE_LIMITS = {
  authorMax: 16,
  contentMax: 70,
  minFillMs: 1200,
  perIpCooldownMs: 90_000,
  perIpHour: 3,
  perIpDay: 8,
  globalHour: 12,
  globalDay: 100,
  maxPending: 60,
  maxTotal: 800,
  maxPublishedPerPost: 40,
  maxPendingPerPost: 8
};

export const glyphs = value => [...String(value ?? '')].length;

export function tidyNote(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseNote(input) {
  const author = tidyNote(input.author);
  const content = tidyNote(input.content);
  if (!author || glyphs(author) > NOTE_LIMITS.authorMax) throw Error('请留下一至十六字署名');
  if (!content || glyphs(content) > NOTE_LIMITS.contentMax) throw Error('请写下不超过七十个字');
  if (URL_LIKE.test(author) || URL_LIKE.test(content) || FORBIDDEN.test(author + content)) {
    throw Error('请只留下文字，不必放链接');
  }
  return {author, content};
}

export function isHoneypot(input) {
  const trap = tidyNote(input.website || input.url || input.homepage);
  if (trap) return true;
  const openedAt = Number(input.openedAt);
  if (!Number.isFinite(openedAt)) return true;
  const elapsed = Date.now() - openedAt;
  return elapsed < NOTE_LIMITS.minFillMs || elapsed > 86_400_000;
}

export function sameOrigin(req) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const matches = value => {
    try { return new URL(value).host === host; } catch { return false; }
  };
  if (origin) return matches(origin);
  if (referer) return matches(referer);
  return process.env.NODE_ENV !== 'production';
}
