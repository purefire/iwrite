import { NOTE_LIMITS, glyphs, isHoneypot, parseNote, sameOrigin, tidyNote } from '../lib/notes.mjs';

function assert(ok, message) {
  if (!ok) throw Error(message);
}

function rejects(fn, fragment) {
  try {
    fn();
  } catch (error) {
    if (String(error.message).includes(fragment)) return;
    throw Error(`expected “${fragment}”, got “${error.message}”`);
  }
  throw Error(`expected failure: ${fragment}`);
}

assert(NOTE_LIMITS.perIpCooldownMs === 90_000 && NOTE_LIMITS.perIpHour === 3 && NOTE_LIMITS.perIpDay === 8, 'per-ip caps');
assert(NOTE_LIMITS.globalDay === 100, 'global day cap');
assert(glyphs('七十个字以内的一行') === 9, 'glyph count');
assert(glyphs('🙂') === 1, 'emoji is one glyph');
assert(tidyNote('  甲\u200B乙\n丙  ') === '甲乙 丙', 'tidy strips zero-width and collapses space');

const note = parseNote({author:'吕京', content:'读到这里，留下一句。'});
assert(note.author === '吕京' && note.content.includes('留下一句'), 'plain note');

rejects(() => parseNote({author:'', content:'一行'}), '署名');
rejects(() => parseNote({author:'a'.repeat(17), content:'一行'}), '署名');
rejects(() => parseNote({author:'吕京', content:''}), '七十');
rejects(() => parseNote({author:'吕京', content:'字'.repeat(NOTE_LIMITS.contentMax + 1)}), '七十');
rejects(() => parseNote({author:'吕京', content:'<script>alert(1)</script>'}), '文字');
rejects(() => parseNote({author:'吕京', content:'请看 https://evil.test'}), '文字');
rejects(() => parseNote({author:'http://x', content:'你好'}), '文字');

const opened = Date.now() - 2000;
assert(isHoneypot({website:'https://bot.test', author:'甲', content:'乙', openedAt: opened}), 'filled honeypot');
assert(isHoneypot({author:'甲', content:'乙', openedAt: Date.now()}), 'too fast');
assert(isHoneypot({author:'甲', content:'乙'}), 'missing openedAt');
assert(!isHoneypot({author:'甲', content:'乙', openedAt: opened, website:''}), 'human note');

assert(sameOrigin({headers:{host:'jing.lv', origin:'https://jing.lv'}}), 'same origin');
assert(!sameOrigin({headers:{host:'jing.lv', origin:'https://evil.test'}}), 'cross origin');
assert(!sameOrigin({headers:{host:'jing.lv', referer:'https://evil.test/x'}}), 'cross referer');

console.log('notes: ok');
