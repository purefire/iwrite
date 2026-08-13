import { permalinkFor, plainText } from './html.mjs';

const tokenize = value => {
  const text = String(value || '').toLowerCase();
  const latin = text.match(/[a-z0-9]+/g) || [];
  const chars = text.match(/[\u4e00-\u9fff]/g) || [];
  const grams = chars.length >= 2 ? chars.slice(0, -1).map((char, index) => char + chars[index + 1]) : chars;
  return [...latin, ...grams];
};

function snippetAround(text, terms, width = 72) {
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return text.slice(0, width * 2).trim();
  const start = Math.max(0, index - width);
  const end = Math.min(text.length, index + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

export function searchPosts(posts, query, limit = 8) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const terms = [...new Set(tokenize(raw))].filter(term => term.length > 0);
  if (!terms.length) return [];
  return posts.map(post => {
    const title = post.title || '';
    const category = post.category || '';
    const body = plainText(post.content);
    const hayTitle = title.toLowerCase();
    const hayCategory = category.toLowerCase();
    const hayBody = body.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (hayTitle.includes(term)) score += term.length > 1 ? 12 : 6;
      if (hayCategory.includes(term)) score += 4;
      const count = hayBody.split(term).length - 1;
      score += Math.min(count, 8) * (term.length > 1 ? 3 : 1);
    }
    if (hayTitle.includes(raw.toLowerCase())) score += 18;
    if (!score) return null;
    return {
      id: post.id,
      title: post.title,
      category: post.category,
      date: post.date,
      slug: post.slug,
      permalink: post.permalink || permalinkFor(post),
      score,
      snippet: snippetAround(body, terms.filter(term => term.length > 1).concat(terms))
    };
  }).filter(Boolean).sort((left, right) => right.score - left.score || right.date.localeCompare(left.date)).slice(0, limit);
}

export function extractiveAnswer(question, hits) {
  if (!hits.length) {
    return '档案里没有直接对应的记录。可以换一个词，或从年表、栏目里继续翻阅。';
  }
  const lines = hits.map((hit, index) => `${index + 1}. 《${hit.title}》 · ${hit.date} · ${hit.category}\n${hit.snippet}`);
  return `从 ${hits.length} 条档案中检索到与「${question.trim()}」相关的记录：\n\n${lines.join('\n\n')}`;
}

export function relatedPosts(posts, current, limit = 3) {
  if (!current) return [];
  const others = posts.filter(post => post.id !== current.id);
  const sameCategory = others.filter(post => post.category === current.category);
  const pool = sameCategory.length >= limit ? sameCategory : others;
  return searchPosts(pool, `${current.title} ${plainText(current.content).slice(0, 80)}`, limit)
    .filter(hit => hit.id !== current.id)
    .slice(0, limit);
}

function parseSseJson(line) {
  if (!line.startsWith('data:')) return '';
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  try {
    const json = JSON.parse(payload);
    return json.candidates?.[0]?.content?.parts?.map(part => part.text).join('') || '';
  } catch {
    return '';
  }
}

export async function streamGemini({ question, hits, apiKey, model = process.env.GEMINI_MODEL || 'gemini-2.0-flash', onToken }) {
  const context = hits.map((hit, index) => `[${index + 1}] 《${hit.title}》（${hit.date}，${hit.category}）\n${hit.snippet}`).join('\n\n');
  const prompt = `你是 jing.lv 私人档案的检索助手。只根据下面的档案摘录回答，用中文，简洁、克制、像一位熟悉这批诗文与旧文的人在翻档。不要编造档案里没有的事实。如果摘录不够，就明说，并指出最接近的篇目。回答中用《标题》引用文章。\n\n问题：${question}\n\n档案摘录：\n${context || '（没有检索到摘录）'}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.4, maxOutputTokens:700}})
  });
  if (!response.ok) {
    const detail = await response.text();
    throw Error(detail.slice(0, 180) || '模型暂时不可用');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', full = '';
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream:true});
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const token = parseSseJson(line);
      if (!token) continue;
      full += token;
      await onToken(token);
    }
  }
  const last = parseSseJson(buffer);
  if (last) {
    full += last;
    await onToken(last);
  }
  return full.trim();
}
