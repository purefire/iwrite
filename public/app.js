const $ = selector => document.querySelector(selector);
const state = {posts: [], filter: '全部', year: '全部', authenticated: false, selected: null, editing: null, oracle: false, commandIndex: 0, pendingNotes: 0};
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
const api = async (url, options = {}) => {
  const response = await fetch(url, {headers: {'Content-Type':'application/json', ...(options.headers || {})}, ...options});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '请求失败');
  return data;
};
const uploadMedia = async (file, kind) => {
  const form = new FormData(); form.append('kind', kind); form.append('file', file);
  const response = await fetch('/api/media', {method:'POST', body:form});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '上传失败');
  return data;
};
const dateLabel = value => new Intl.DateTimeFormat('zh-CN', {year:'numeric', month:'long', day:'numeric'}).format(new Date(`${value}T00:00:00`));
const shortDate = value => new Intl.DateTimeFormat('zh-CN', {year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(`${value}T00:00:00`)).replaceAll('/', '.');
const wordCount = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s/g, '').length;
const plainText = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const textToHtml = value => esc(value).split(/\n\s*\n/).filter(Boolean).map(paragraph => `<p>${paragraph.replaceAll('\n', '<br>')}</p>`).join('');
const postHtml = post => post.contentFormat === 'html' ? post.content : textToHtml(post.content);
const publishedPosts = () => state.posts.filter(post => post.published || state.authenticated);
const permalink = post => post.permalink || `/?post=${encodeURIComponent(post.id)}`;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function tokenize(value) {
  const text = String(value || '').toLowerCase();
  const latin = text.match(/[a-z0-9]+/g) || [];
  const chars = text.match(/[\u4e00-\u9fff]/g) || [];
  const grams = chars.length >= 2 ? chars.slice(0, -1).map((char, index) => char + chars[index + 1]) : chars;
  return [...latin, ...grams];
}
function verseKind(post) {
  const named = post.category === '诗囊' || post.category === '新春贺辞';
  const lines = plainText(post.content).split(/\n+/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return named ? 'classical' : '';
  const short = lines.filter(line => line.length <= 22).length / lines.length;
  const classical = lines.filter(line => line.length >= 5 && line.length <= 16).length / lines.length;
  if (!named && short < 0.7) return '';
  return classical >= 0.55 ? 'classical' : 'modern';
}
function categories() { return ['全部', ...new Set(state.posts.map(post => post.category))]; }
function yearsOf(posts) {
  const counts = new Map();
  posts.forEach(post => { const year = post.date.slice(0, 4); counts.set(year, (counts.get(year) || 0) + 1); });
  return [...counts.entries()].sort(([left], [right]) => Number(right) - Number(left));
}

function renderChronicle(posts) {
  const years = yearsOf(posts);
  $('#chronicle').innerHTML = [`<button type="button" class="chronicle-year ${state.year === '全部' ? 'active' : ''}" data-year="全部" aria-pressed="${state.year === '全部'}"><span>全部</span><b>${String(posts.length).padStart(2, '0')}</b></button>`, ...years.map(([year, count]) => `<button type="button" class="chronicle-year ${state.year === year ? 'active' : ''}" data-year="${year}" aria-pressed="${state.year === year}"><span>${year}</span><b>${String(count).padStart(2, '0')}</b></button>`)].join('');
  document.querySelectorAll('[data-year]').forEach(button => button.onclick = () => { state.year = button.dataset.year; renderArchive(); });
}

function openingLines(post) {
  const source = post.contentFormat === 'html'
    ? post.content.replace(/<\s*br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]*>/g, '')
    : post.content;
  const lines = source.split(/\n+/).map(line => line.replace(/&nbsp;/g, ' ').trim()).filter(Boolean);
  return (lines.length > 1 ? lines : plainText(source).split(/[。！？；]/)).map(line => line.trim()).filter(Boolean).slice(0, 4);
}

function renderArchive() {
  const all = publishedPosts();
  const visible = all.filter(post => (state.filter === '全部' || post.category === state.filter) && (state.year === '全部' || post.date.startsWith(state.year)));
  const [feature, ...rest] = visible;
  $('#post-count').textContent = `${visible.length.toString().padStart(2, '0')} / ${all.length.toString().padStart(2, '0')} RECORDS`;
  renderChronicle(all);
  drawSky(all);
  $('#filters').innerHTML = categories().map(category => `<button class="filter ${category === state.filter ? 'active' : ''}" type="button" data-filter="${esc(category)}">${esc(category)}</button>`).join('');
  const lines = feature ? openingLines(feature).map(line => esc(line)).join('<br>') : '';
  $('#featured-post').innerHTML = feature ? `
    <a class="featured-link" href="${esc(permalink(feature))}" data-post-id="${esc(feature.id)}">
      <span class="feature-index">01</span><div class="featured-copy"><span class="post-category">${esc(feature.category).toUpperCase()}</span><h2>${esc(feature.title)}</h2>
      <span class="feature-verse">${lines}</span><span class="post-foot"><time>${shortDate(feature.date)}</time><span>阅读全文 ↗</span></span></div>
    </a>` : '<p class="empty-state">该年份或栏目暂时没有文章。</p>';
  $('#post-list').innerHTML = rest.map((post, index) => `
    <a class="post" href="${esc(permalink(post))}" data-post-id="${esc(post.id)}">
      <time class="post-date">${shortDate(post.date)}</time><span class="post-number">${String(index + 2).padStart(2, '0')}</span>
      <span><span class="post-category">${esc(post.category)}</span><strong>${esc(post.title)}</strong>${!post.published ? '<small>草稿</small>' : ''}${post.commentCount ? `<small class="comment-count">${post.commentCount} 评</small>` : ''}</span><span class="post-arrow">↗</span>
    </a>`).join('');
  document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => { state.filter = button.dataset.filter; renderArchive(); });
  bindPostLinks();
}

function bindPostLinks() {
  document.querySelectorAll('[data-post-id]').forEach(node => {
    node.onclick = event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openPost(state.posts.find(post => post.id === node.dataset.postId) || {id: node.dataset.postId});
    };
  });
}

function hideViews() {
  $('#archive-view').hidden = true;
  $('#reader-view').hidden = true;
  $('#about-view').hidden = true;
  document.body.classList.remove('is-reading', 'is-about');
}

function showArchive() {
  state.selected = null;
  hideViews();
  $('#archive-view').hidden = false;
  document.title = 'JING.LV — 私人档案';
  $('#reading-progress').style.width = '0';
  drawSky(publishedPosts());
}

function showAbout(push = true) {
  state.selected = null;
  if (push) history.pushState({view:'about'}, '', '/about');
  hideViews();
  $('#about-view').hidden = false;
  document.body.classList.add('is-about');
  document.title = 'About — JING.LV';
  const posts = publishedPosts();
  const span = yearsOf(posts);
  $('#about-stats').textContent = `${posts.length} 篇 · ${span.at(-1)?.[0] || '2012'}–${span[0]?.[0] || ''} · ${categories().length - 1} 个栏目`;
  window.scrollTo({top: 0, behavior: 'auto'});
}

function goHome(push = true, anchor = '') {
  if (push) history.pushState({}, '', '/');
  showArchive();
  if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({behavior:'smooth'}));
  else window.scrollTo({top: 0, behavior: 'smooth'});
}

async function openPost(post, push = true) {
  if (!post) return;
  try { post = await api(`/api/posts/${encodeURIComponent(post.id)}`); }
  catch { if (!post.content) return; }
  state.selected = post;
  if (push) history.pushState({post: post.id}, '', permalink(post));
  renderReader(post);
  hideViews();
  $('#reader-view').hidden = false;
  document.body.classList.add('is-reading');
  document.title = `${post.title} — JING.LV`;
  window.scrollTo({top: 0, behavior: 'auto'});
}

function renderReader(post) {
  const posts = publishedPosts();
  const index = posts.findIndex(item => item.id === post.id);
  const previous = posts[index + 1];
  const next = posts[index - 1];
  const kind = verseKind(post);
  $('#reader-category').textContent = post.category;
  $('#reader-title').textContent = post.title;
  $('#reader-date').textContent = dateLabel(post.date);
  $('#reader-length').textContent = `${wordCount(post.content)} 字 · 约 ${Math.max(1, Math.ceil(wordCount(post.content) / 450))} 分钟`;
  $('#reader-index').textContent = `${String(index + 1).padStart(2, '0')} / ${String(posts.length).padStart(2, '0')}`;
  const content = $('#reader-content');
  content.className = `reader-content${kind ? ` is-verse is-${kind}` : ''}`;
  content.innerHTML = postHtml(post);
  renderToc(content);
  renderComments(post);
  renderRelated(post, posts);
  renderReaderMusic(post);
  const editButton = $('#reader-edit');
  editButton.hidden = !state.authenticated;
  editButton.onclick = () => edit(post);
  $('#reader-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${permalink(post)}`);
      $('#reader-copy').textContent = '已复制';
      setTimeout(() => { $('#reader-copy').textContent = '复制链接'; }, 1400);
    } catch { $('#reader-copy').textContent = '复制失败'; }
  };
  renderAdjacent($('#reader-prev'), previous, '← 较早文章');
  renderAdjacent($('#reader-next'), next, '较新文章 →');
}

function renderToc(content) {
  const headings = [...content.querySelectorAll('h2, h3')];
  const toc = $('#reader-toc');
  if (headings.length < 2) { toc.hidden = true; toc.innerHTML = ''; return; }
  headings.forEach((heading, index) => { heading.id = heading.id || `section-${index + 1}`; });
  toc.hidden = false;
  toc.innerHTML = headings.map(heading => `<a href="#${esc(heading.id)}">${esc(heading.textContent)}</a>`).join('');
}

function noteText(value) {
  return esc(plainText(value)).replaceAll('\n', '<br>');
}

function renderComments(post) {
  const list = $('#comment-list');
  const published = post.comments || [];
  const pending = state.authenticated ? (post.pendingNotes || []) : [];
  list.innerHTML = (published.length || pending.length) ? `<div class="section-kicker"><span>ARCHIVE NOTES</span><span>${String(published.length).padStart(2, '0')}</span></div>` : '';
  list.innerHTML += published.map(comment => `
    <article class="comment">
      <header><strong>${esc(comment.author)}</strong><time>${esc(comment.date)}</time></header>
      <p>${noteText(comment.content)}</p>
    </article>`).join('');
  list.innerHTML += pending.map(comment => `
    <article class="comment is-pending">
      <header><strong>${esc(comment.author)}</strong><time>待审</time></header>
      <p>${noteText(comment.content)}</p>
      <div class="comment-review">
        <button type="button" data-review="${esc(comment.id)}" data-action="publish">收下</button>
        <button type="button" data-review="${esc(comment.id)}" data-action="reject">放下</button>
      </div>
    </article>`).join('');
  list.querySelectorAll('[data-review]').forEach(button => {
    button.onclick = () => reviewNote(button.dataset.review, button.dataset.action);
  });
  const form = $('#note-form');
  form.elements.openedAt.value = String(Date.now());
  form.elements.website.value = '';
  $('#note-error').textContent = '';
  $('#note-error').classList.remove('is-ok');
  const saved = localStorage.getItem('jing-note-author');
  if (saved && !form.elements.author.value) form.elements.author.value = saved.slice(0, 16);
}

function renderRelated(post, posts) {
  const node = $('#reader-related');
  const terms = tokenize(`${post.title} ${plainText(post.content).slice(0, 80)}`);
  const related = posts.filter(item => item.id !== post.id).map(item => {
    const hay = `${item.title} ${item.category} ${plainText(item.content).slice(0, 400)}`.toLowerCase();
    const score = (item.category === post.category ? 4 : 0) + terms.filter(term => hay.includes(term)).length;
    return {item, score};
  }).filter(entry => entry.score > 2).sort((left, right) => right.score - left.score).slice(0, 3).map(entry => entry.item);
  if (!related.length) { node.hidden = true; node.innerHTML = ''; return; }
  node.hidden = false;
  node.innerHTML = `<div class="section-kicker"><span>ADJACENT IN THE ARCHIVE</span></div>` + related.map(item => `<a href="${esc(permalink(item))}" data-post-id="${esc(item.id)}"><span>${esc(item.category)} · ${shortDate(item.date)}</span><strong>${esc(item.title)}</strong></a>`).join('');
  bindPostLinks();
}

function renderAdjacent(button, post, direction) {
  if (!post) { button.hidden = true; return; }
  button.hidden = false;
  button.innerHTML = `<span>${direction}</span><strong>${esc(post.title)}</strong><small>${esc(post.category)} · ${shortDate(post.date)}</small>`;
  button.onclick = () => openPost(post);
}

function renderReaderMusic(post) {
  const container = $('#reader-music');
  if (!post.backgroundMusicId) { container.hidden = true; container.innerHTML = ''; return; }
  container.hidden = false;
  container.innerHTML = `<audio preload="none" src="/media/${esc(post.backgroundMusicId)}"></audio><button type="button">聆听配乐</button>`;
  const audio = container.querySelector('audio'), button = container.querySelector('button');
  button.onclick = async () => {
    try {
      if (audio.paused) { await audio.play(); button.textContent = '暂停配乐'; }
      else { audio.pause(); button.textContent = '聆听配乐'; }
    } catch { button.textContent = '配乐暂不可用'; }
  };
  audio.onended = () => { button.textContent = '聆听配乐'; };
}

function drawSky(posts) {
  const canvas = $('#archive-sky');
  if (!canvas || $('#archive-view').hidden) return;
  const years = yearsOf(posts);
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  const height = canvas.clientHeight || 220;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!years.length) return;
  const max = Math.max(...years.map(entry => entry[1]));
  years.forEach(([year, count], index) => {
    const x = width * (0.18 + (index / Math.max(years.length - 1, 1)) * 0.7);
    const y = height * (0.28 + (1 - count / max) * 0.46);
    const radius = 1.6 + (count / max) * 4.2;
    ctx.beginPath();
    ctx.arc(x, y, radius + 8, 0, Math.PI * 2);
    ctx.fillStyle = year === state.year ? 'rgba(83,107,153,.16)' : 'rgba(83,107,153,.05)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = year === state.year ? '#536b99' : 'rgba(28,33,31,.45)';
    ctx.fill();
  });
}

function commandItems(query) {
  const raw = query.trim();
  const ask = raw.startsWith('?') || raw.startsWith('？') || /[\s]/.test(raw) && raw.length > 8;
  const needle = raw.replace(/^[?？]\s*/, '').toLowerCase();
  const posts = publishedPosts();
  const items = [];
  if (!needle) {
    items.push({type:'action', id:'oracle', title:'询问档案', detail:'从全部已发表文章中检索并作答'});
    items.push({type:'action', id:'about', title:'关于', detail:'Purefire Studio · Stay hungry Stay foolish'});
    yearsOf(posts).slice(0, 6).forEach(([year, count]) => items.push({type:'year', id:year, title:year, detail:`${count} 篇`}));
    return items;
  }
  if (ask || raw.startsWith('?') || raw.startsWith('？')) items.push({type:'ask', id:'ask', title:`询问档案：${needle}`, detail:'引用原文段落作答', question: needle});
  categories().filter(category => category !== '全部' && category.toLowerCase().includes(needle)).forEach(category => {
    items.push({type:'category', id:category, title:category, detail:'栏目'});
  });
  yearsOf(posts).filter(([year]) => year.includes(needle)).forEach(([year, count]) => items.push({type:'year', id:year, title:year, detail:`${count} 篇`}));
  posts.filter(post => `${post.title} ${post.category} ${post.excerpt || ''} ${plainText(post.content).slice(0, 400)}`.toLowerCase().includes(needle) || tokenize(needle).every(term => `${post.title}${post.content}`.toLowerCase().includes(term))).slice(0, 8).forEach(post => {
    items.push({type:'post', id:post.id, title:post.title, detail:`${post.category} · ${shortDate(post.date)}`, post});
  });
  return items.slice(0, 10);
}

function renderCommand(query = $('#command-input').value) {
  const items = commandItems(query);
  state.commandIndex = Math.max(0, Math.min(state.commandIndex, Math.max(items.length - 1, 0)));
  $('#command-results').innerHTML = items.length ? items.map((item, index) => `
    <button type="button" class="command-item ${index === state.commandIndex ? 'active' : ''}" data-command-index="${index}" role="option" aria-selected="${index === state.commandIndex}">
      <span>${esc(item.type.toUpperCase())}</span><strong>${esc(item.title)}</strong><small>${esc(item.detail || '')}</small>
    </button>`).join('') : '<p class="empty-state">没有匹配的档案。</p>';
  $('#command-results').querySelectorAll('[data-command-index]').forEach(button => {
    button.onmouseenter = () => { state.commandIndex = Number(button.dataset.commandIndex); renderCommand(query); };
    button.onclick = () => runCommand(items[Number(button.dataset.commandIndex)]);
  });
  return items;
}

function openCommand() {
  $('#command-dialog').showModal();
  $('#command-input').value = '';
  state.commandIndex = 0;
  renderCommand('');
  setTimeout(() => $('#command-input').focus(), 0);
}

function runCommand(item) {
  if (!item) return;
  $('#command-dialog').close();
  if (item.type === 'post') return openPost(item.post);
  if (item.type === 'year') { state.year = item.id; goHome(true, 'archive'); renderArchive(); return; }
  if (item.type === 'category') { state.filter = item.id; goHome(true, 'archive'); renderArchive(); return; }
  if (item.type === 'action' && item.id === 'about') return showAbout();
  if (item.type === 'ask' || item.id === 'oracle') return openOracle(item.question || '');
}

function openOracle(question = '') {
  $('#oracle-panel').hidden = false;
  document.body.classList.add('oracle-open');
  $('#oracle-note').textContent = state.oracle ? '模型会根据检索到的原文段落作答，并指出篇目。' : '当前为原文检索：直接引用档案段落，不经过生成模型。';
  if (question) {
    $('#oracle-form').elements.question.value = question;
    askOracle(question);
  } else $('#oracle-form').elements.question.focus();
}

function closeOracle() {
  $('#oracle-panel').hidden = true;
  document.body.classList.remove('oracle-open');
}

async function askOracle(question) {
  const thread = $('#oracle-thread');
  thread.insertAdjacentHTML('beforeend', `<article class="oracle-q"><span>问</span><p>${esc(question)}</p></article><article class="oracle-a"><span>档</span><p class="oracle-stream"></p><div class="oracle-hits"></div></article>`);
  const answer = thread.querySelector('.oracle-a:last-child .oracle-stream');
  const hitsNode = thread.querySelector('.oracle-a:last-child .oracle-hits');
  thread.scrollTop = thread.scrollHeight;
  try {
    const response = await fetch('/api/ask', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({question})});
    if (!response.ok) {
      const data = await response.json().catch(() => ({error:'询问失败'}));
      throw Error(data.error || '询问失败');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream:true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consumeOracleLine(line, answer, hitsNode);
    }
    consumeOracleLine(buffer, answer, hitsNode);
  } catch (error) {
    answer.textContent = error.message;
  }
  thread.scrollTop = thread.scrollHeight;
}

function consumeOracleLine(line, answer, hitsNode) {
  if (!line.startsWith('data:')) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  try {
    const data = JSON.parse(payload);
    if (data.hits) {
      hitsNode.innerHTML = data.hits.map(hit => `<a href="${esc(hit.permalink)}" data-post-id="${esc(hit.id)}">${esc(hit.title)}</a>`).join('');
      bindPostLinks();
    }
    if (data.token) answer.textContent += data.token;
  } catch { /* ignore a truncated SSE chunk */ }
}

function setEditorContent(post) {
  const content = $('#editor-content');
  content.innerHTML = post ? postHtml(post) : '<p><br></p>';
  updateEditorStatus();
}
function updateEditorStatus() {
  const content = $('#editor-content');
  $('#editor-word-count').textContent = `${wordCount(content.innerHTML)} 字`;
  if (!$('#editor-preview').hidden) renderEditorPreview();
}
function setMusicStatus(id, label) {
  $('#music-status').textContent = label || '未设置';
  $('#clear-music').hidden = !id;
}
function renderEditorPreview() { $('#editor-preview').innerHTML = $('#editor-content').innerHTML; }
function edit(post) {
  state.editing = post || null;
  const form = $('#editor-form');
  form.reset();
  const data = post || {date: new Date().toISOString().slice(0, 10), category:'诗囊', published:true};
  Object.entries(data).forEach(([key, value]) => {
    if (!form.elements[key]) return;
    form.elements[key].type === 'checkbox' ? form.elements[key].checked = Boolean(value) : form.elements[key].value = value;
  });
  setMusicStatus(data.backgroundMusicId, data.backgroundMusicId ? '已关联配乐' : '未设置');
  $('#editor-title').textContent = post ? '编辑文章' : '新文章';
  $('#delete-post').hidden = !post;
  $('#editor-preview').hidden = true;
  $('#editor-content').hidden = false;
  $('#preview-button').textContent = '预览';
  setEditorContent(post);
  $('#editor-error').textContent = '';
  $('#editor-dialog').showModal();
  setTimeout(() => $('#editor-content').focus(), 0);
}
function executeCommand(button) {
  const command = button.dataset.command;
  if (command === 'createLink') {
    const href = window.prompt('输入链接地址（https://…）');
    if (!href) return;
    document.execCommand('createLink', false, href);
  } else document.execCommand(command, false, button.dataset.value || null);
  $('#editor-content').focus();
  updateEditorStatus();
}
function bindEditor() {
  $('.editor-toolbar').addEventListener('mousedown', event => {
    if (event.target.closest('[data-command]')) event.preventDefault();
  });
  $('.editor-toolbar').addEventListener('click', event => {
    const button = event.target.closest('[data-command]');
    if (button) executeCommand(button);
  });
  $('#editor-content').addEventListener('input', updateEditorStatus);
  const imageInput = $('#image-upload'), musicInput = $('#music-upload');
  const insertImages = async files => {
    if (!files.length) return;
    try {
      $('#editor-error').textContent = `正在上传 ${files.length} 张图片…`;
      for (const file of files) {
        const media = await uploadMedia(file, 'image');
        $('#editor-content').insertAdjacentHTML('beforeend', `<p><img src="/media/${esc(media.id)}" alt="${esc(media.originalName)}"></p>`);
      }
      $('#editor-error').textContent = ''; updateEditorStatus();
    } catch (error) { $('#editor-error').textContent = error.message; }
    finally { imageInput.value = ''; }
  };
  $('#insert-image').onclick = () => imageInput.click();
  $('#upload-images').onclick = () => imageInput.click();
  imageInput.onchange = () => insertImages([...imageInput.files]);
  $('#upload-music').onclick = () => musicInput.click();
  musicInput.onchange = async () => {
    const file = musicInput.files[0]; if (!file) return;
    try {
      $('#editor-error').textContent = '正在上传配乐…';
      const media = await uploadMedia(file, 'audio');
      $('#editor-form').elements.backgroundMusicId.value = media.id;
      setMusicStatus(media.id, media.originalName); $('#editor-error').textContent = '';
    } catch (error) { $('#editor-error').textContent = error.message; }
    finally { musicInput.value = ''; }
  };
  $('#clear-music').onclick = () => { $('#editor-form').elements.backgroundMusicId.value = ''; setMusicStatus('', '未设置'); };
  $('#preview-button').onclick = () => {
    const preview = $('#editor-preview'), editor = $('#editor-content');
    const previewing = preview.hidden;
    if (previewing) renderEditorPreview();
    preview.hidden = !previewing; editor.hidden = previewing;
    $('#preview-button').textContent = previewing ? '继续编辑' : '预览';
  };
  $('#new-post').onclick = () => edit();
  $('#delete-post').onclick = async () => {
    const post = state.editing;
    if (!post || !window.confirm(`确定删除《${post.title}》？此操作不可恢复。`)) return;
    try {
      await api(`/api/posts/${encodeURIComponent(post.id)}`, {method:'DELETE'});
      state.posts = await api('/api/posts');
      renderArchive(); $('#editor-dialog').close();
      if (state.selected?.id === post.id) goHome();
    } catch (error) { $('#editor-error').textContent = error.message; }
  };
  $('#logout-button').onclick = async () => {
    try {
      await api('/api/logout', {method:'POST'});
      state.authenticated = false;
      state.posts = await api('/api/posts');
      setPendingBadge(0);
      if ($('#review-dialog').open) $('#review-dialog').close();
      $('#admin-button').textContent = '登录';
      $('#editor-dialog').close(); renderArchive();
      const selected = state.posts.find(post => post.id === state.selected?.id);
      if (selected) { state.selected = selected; renderReader(selected); }
      else if (state.selected) goHome();
    } catch (error) { $('#editor-error').textContent = error.message; }
  };
  $('#editor-form').onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const html = $('#editor-content').innerHTML.trim();
    if (!plainText(html)) { $('#editor-error').textContent = '正文不能为空'; return; }
    form.set('content', html); form.set('contentFormat', 'html');
    const id = form.get('id');
    const data = Object.fromEntries(form); data.published = form.get('published') === 'on';
    try {
      const saved = await api(id ? `/api/posts/${encodeURIComponent(id)}` : '/api/posts', {method:id ? 'PUT' : 'POST', body:JSON.stringify(data)});
      state.posts = await api('/api/posts');
      renderArchive(); $('#editor-dialog').close();
      if (state.selected?.id === saved.id) openPost(saved, false);
    } catch (error) { $('#editor-error').textContent = error.message; }
  };
}
function bindClose() { document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close()); }
async function login(event) {
  event.preventDefault();
  try {
    await api('/api/login', {method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});
    state.authenticated = true;
    state.posts = await api('/api/posts');
    const me = await api('/api/me');
    setPendingBadge(me.pendingNotes);
    $('#admin-button').textContent = '写文章';
    $('#login-dialog').close(); renderArchive(); edit();
  } catch (error) { $('#login-error').textContent = error.message; }
}

function findFromRoute() {
  const params = new URLSearchParams(location.search);
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const blog = path.match(/^\/blog\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)$/);
  const categoryPath = path.match(/^\/blog\/category\/([^/]+)$/);
  if (path === '/about' || path === '/sample-page') return {view:'about'};
  if (path.startsWith('/blog/author/')) return {view:'archive'};
  if (categoryPath) {
    const slug = decodeURIComponent(categoryPath[1]);
    const mapped = {tech:'技术分享', newyearpoem:'新春贺辞', uncategorized:'未分类'}[slug] || slug;
    const category = categories().find(item => item === mapped || item.toLowerCase() === mapped.toLowerCase());
    if (category) state.filter = category;
    return {view:'archive'};
  }
  if (blog) {
    const slug = decodeURIComponent(blog[4]);
    const date = `${blog[1]}-${blog[2]}-${blog[3]}`;
    const post = state.posts.find(item => item.slug === slug || (item.date === date && (item.slug === slug || item.id === slug)))
      || state.posts.find(item => permalink(item).includes(`/${blog[1]}/${blog[2]}/${blog[3]}/`));
    return {view:'post', ref: slug, post};
  }
  const ref = params.get('post') || params.get('p');
  if (!ref) return {view:'archive'};
  const post = state.posts.find(item => item.id === ref || item.id === `wp-${ref}` || item.slug === ref);
  return {view:'post', ref, post};
}

async function applyRoute() {
  const route = findFromRoute();
  if (route.view === 'about') return showAbout(false);
  if (route.view !== 'post') return showArchive();
  try {
    const post = route.post || await api(`/api/posts/${encodeURIComponent(route.ref)}`);
    await openPost(post, false);
  } catch { history.replaceState({}, '', '/'); showArchive(); }
}

function updateReadingProgress() {
  if (!state.selected) return;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  $('#reading-progress').style.width = `${max > 0 ? Math.min(100, window.scrollY / max * 100) : 0}%`;
}

function bindKeys() {
  document.addEventListener('keydown', event => {
    const typing = /input|textarea|select/i.test(event.target.tagName) || event.target.isContentEditable;
    const meta = event.metaKey || event.ctrlKey;
    if ((meta && event.key.toLowerCase() === 'k') || (!typing && event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey)) {
      event.preventDefault();
      if ($('#command-dialog').open) $('#command-dialog').close();
      else openCommand();
      return;
    }
    if (event.key === 'Escape') {
      if ($('#command-dialog').open) return;
      if (!$('#oracle-panel').hidden) { closeOracle(); return; }
    }
    if ($('#command-dialog').open) {
      const items = commandItems($('#command-input').value);
      if (event.key === 'ArrowDown') { event.preventDefault(); state.commandIndex += 1; renderCommand(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); state.commandIndex -= 1; renderCommand(); }
      if (event.key === 'Enter') { event.preventDefault(); runCommand(items[state.commandIndex]); }
      return;
    }
    if (typing || meta) return;
    if (event.key === 'j' || event.key === 'k') {
      const posts = publishedPosts().filter(post => (state.filter === '全部' || post.category === state.filter) && (state.year === '全部' || post.date.startsWith(state.year)));
      if (!posts.length) return;
      const index = Math.max(0, posts.findIndex(post => post.id === state.selected?.id));
      const next = event.key === 'j' ? posts[state.selected ? index + 1 : 0] : posts[state.selected ? index - 1 : 0];
      if (next) openPost(next);
    }
  });
}

function glyphs(value) { return [...String(value ?? '')].length; }

function setPendingBadge(count) {
  state.pendingNotes = Number(count || 0);
  const button = $('#review-button');
  button.hidden = !state.authenticated;
  button.textContent = state.pendingNotes ? `审阅 ${String(state.pendingNotes).padStart(2, '0')}` : '审阅';
}

async function reviewNote(id, action) {
  try {
    const result = await api(`/api/comments/${encodeURIComponent(id)}`, {method:'POST', body: JSON.stringify({action})});
    setPendingBadge(result.pendingNotes);
    if (state.selected) await openPost(state.selected, false);
    if ($('#review-dialog').open) await renderReviewQueue();
  } catch (error) {
    $('#note-error').textContent = error.message;
  }
}

async function renderReviewQueue() {
  const notes = await api('/api/comments');
  $('#review-list').innerHTML = notes.length ? notes.map(note => `
    <article class="review-item">
      <header><strong>${esc(note.author)}</strong><span>${esc(note.postTitle || '')}</span><time>${esc(note.date)}</time></header>
      <p>${noteText(note.content)}</p>
      <div class="comment-review">
        <button type="button" data-review="${esc(note.id)}" data-action="publish">收下</button>
        <button type="button" data-review="${esc(note.id)}" data-action="reject">放下</button>
      </div>
    </article>`).join('') : '<p class="empty-state">没有待审的一行。</p>';
  $('#review-list').querySelectorAll('[data-review]').forEach(button => {
    button.onclick = () => reviewNote(button.dataset.review, button.dataset.action);
  });
}

function bindNoteForm() {
  const form = $('#note-form');
  const content = form.elements.content;
  const count = $('#note-count');
  const error = $('#note-error');
  const stamp = () => { form.elements.openedAt.value = String(Date.now()); };
  const updateCount = () => {
    const used = glyphs(content.value);
    count.textContent = `${used} / 70`;
    count.classList.toggle('is-full', used >= 70);
  };
  const touch = () => {
    const opened = Number(form.elements.openedAt.value);
    if (!opened || Date.now() - opened > 12 * 3600 * 1000) stamp();
  };
  content.addEventListener('focus', touch);
  form.elements.author.addEventListener('focus', touch);
  content.addEventListener('input', () => {
    if (glyphs(content.value) > 70) content.value = [...content.value].slice(0, 70).join('');
    updateCount();
  });
  form.elements.author.addEventListener('input', () => {
    if (glyphs(form.elements.author.value) > 16) form.elements.author.value = [...form.elements.author.value].slice(0, 16).join('');
  });
  form.onsubmit = async event => {
    event.preventDefault();
    if (!state.selected) return;
    const payload = Object.fromEntries(new FormData(form));
    payload.postId = state.selected.id;
    try {
      error.textContent = '';
      error.classList.remove('is-ok');
      await api('/api/comments', {method:'POST', body: JSON.stringify(payload)});
      localStorage.setItem('jing-note-author', String(payload.author || '').slice(0, 16));
      form.elements.content.value = '';
      form.elements.website.value = '';
      stamp();
      updateCount();
      error.classList.add('is-ok');
      error.textContent = '已收下，审过才会出现。';
    } catch (err) {
      error.classList.remove('is-ok');
      error.textContent = err.message;
    }
  };
}

async function init() {
  $('#today').textContent = new Intl.DateTimeFormat('en-GB', {dateStyle:'medium'}).format(new Date()).toUpperCase();
  $('#year').textContent = new Date().getFullYear();
  $('#command-button').querySelector('kbd').textContent = isMac ? '⌘K' : 'Ctrl K';
  const [me, posts] = await Promise.all([api('/api/me'), api('/api/posts')]);
  state.authenticated = me.authenticated; state.oracle = me.oracle; state.posts = posts;
  setPendingBadge(me.pendingNotes);
  $('#admin-button').textContent = me.authenticated ? '写文章' : '登录';
  $('#admin-button').onclick = () => state.authenticated ? edit() : $('#login-dialog').showModal();
  $('#review-button').onclick = async () => { await renderReviewQueue(); $('#review-dialog').showModal(); };
  $('#home-link').onclick = event => { event.preventDefault(); goHome(); };
  $('#footer-home').onclick = event => { event.preventDefault(); goHome(); };
  $('#about-link').onclick = event => { event.preventDefault(); showAbout(); };
  $('#about-back').onclick = () => goHome();
  document.querySelectorAll('[data-home-anchor]').forEach(link => link.onclick = event => { event.preventDefault(); goHome(true, link.dataset.homeAnchor); });
  $('#reader-back').onclick = () => goHome();
  $('#command-button').onclick = openCommand;
  $('#command-input').addEventListener('input', () => { state.commandIndex = 0; renderCommand(); });
  $('#command-form').onsubmit = event => { event.preventDefault(); runCommand(commandItems($('#command-input').value)[state.commandIndex]); };
  $('#oracle-close').onclick = closeOracle;
  $('#oracle-form').onsubmit = event => {
    event.preventDefault();
    const question = new FormData(event.currentTarget).get('question').trim();
    if (!question) return;
    event.currentTarget.reset();
    askOracle(question);
  };
  $('#login-form').onsubmit = login;
  bindClose(); bindEditor(); bindNoteForm(); bindKeys(); renderArchive(); await applyRoute();
  window.addEventListener('popstate', applyRoute);
  window.addEventListener('scroll', updateReadingProgress, {passive:true});
  window.addEventListener('resize', () => drawSky(publishedPosts()), {passive:true});
}
init().catch(error => { $('#post-list').innerHTML = `<p class="error">${esc(error.message)}</p>`; });
