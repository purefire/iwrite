const $ = selector => document.querySelector(selector);
const state = {posts: [], filter: '全部', year: '全部', authenticated: false, selected: null, editing: null};
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

function categories() { return ['全部', ...new Set(state.posts.map(post => post.category))]; }
function renderChronicle(posts) {
  const counts = new Map();
  posts.forEach(post => { const year = post.date.slice(0, 4); counts.set(year, (counts.get(year) || 0) + 1); });
  const years = [...counts.entries()].sort(([left], [right]) => Number(right) - Number(left));
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
  $('#filters').innerHTML = categories().map(category => `<button class="filter ${category === state.filter ? 'active' : ''}" type="button" data-filter="${esc(category)}">${esc(category)}</button>`).join('');
  const lines = feature ? openingLines(feature).map(line => esc(line)).join('<br>') : '';
  $('#featured-post').innerHTML = feature ? `
    <button type="button" class="featured-link" data-post-id="${esc(feature.id)}">
      <span class="feature-index">01</span><div class="featured-copy"><span class="post-category">${esc(feature.category).toUpperCase()}</span><h2>${esc(feature.title)}</h2>
      <span class="feature-verse">${lines}</span><span class="post-foot"><time>${shortDate(feature.date)}</time><span>阅读全文 ↗</span></span></div>
    </button>` : '<p class="empty-state">该年份或栏目暂时没有文章。</p>';
  $('#post-list').innerHTML = rest.map((post, index) => `
    <button type="button" class="post" data-post-id="${esc(post.id)}">
      <time class="post-date">${shortDate(post.date)}</time><span class="post-number">${String(index + 2).padStart(2, '0')}</span>
      <span><span class="post-category">${esc(post.category)}</span><strong>${esc(post.title)}</strong>${!post.published ? '<small>草稿</small>' : ''}</span><span class="post-arrow">↗</span>
    </button>`).join('');
  document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => { state.filter = button.dataset.filter; renderArchive(); });
  document.querySelectorAll('[data-post-id]').forEach(button => button.onclick = () => openPost(state.posts.find(post => post.id === button.dataset.postId)));
}

function showArchive() {
  state.selected = null;
  $('#archive-view').hidden = false;
  $('#reader-view').hidden = true;
  document.body.classList.remove('is-reading');
  document.title = 'JING.LV — 私人档案';
  $('#reading-progress').style.width = '0';
}
function goHome(push = true, anchor = '') {
  if (push && location.search) history.pushState({}, '', '/');
  showArchive();
  if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({behavior:'smooth'}));
  else window.scrollTo({top: 0, behavior: 'smooth'});
}
function openPost(post, push = true) {
  if (!post) return;
  state.selected = post;
  if (push) history.pushState({post: post.id}, '', `/?post=${encodeURIComponent(post.id)}`);
  renderReader(post);
  $('#archive-view').hidden = true;
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
  $('#reader-category').textContent = post.category;
  $('#reader-title').textContent = post.title;
  $('#reader-date').textContent = dateLabel(post.date);
  $('#reader-length').textContent = `${wordCount(post.content)} 字 · 约 ${Math.max(1, Math.ceil(wordCount(post.content) / 450))} 分钟`;
  $('#reader-index').textContent = `${String(index + 1).padStart(2, '0')} / ${String(posts.length).padStart(2, '0')}`;
  $('#reader-content').innerHTML = postHtml(post);
  renderReaderMusic(post);
  const editButton = $('#reader-edit');
  editButton.hidden = !state.authenticated;
  editButton.onclick = () => edit(post);
  renderAdjacent($('#reader-prev'), previous, '← 较早文章');
  renderAdjacent($('#reader-next'), next, '较新文章 →');
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
    $('#admin-button').textContent = '写文章';
    $('#login-dialog').close(); renderArchive(); edit();
  } catch (error) { $('#login-error').textContent = error.message; }
}
async function applyRoute() {
  const id = new URLSearchParams(location.search).get('post');
  if (!id) return showArchive();
  let post = state.posts.find(item => item.id === id);
  try { post ||= await api(`/api/posts/${encodeURIComponent(id)}`); openPost(post, false); }
  catch { history.replaceState({}, '', '/'); showArchive(); }
}
function updateReadingProgress() {
  if (!state.selected) return;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  $('#reading-progress').style.width = `${max > 0 ? Math.min(100, window.scrollY / max * 100) : 0}%`;
}
async function init() {
  $('#today').textContent = new Intl.DateTimeFormat('en-GB', {dateStyle:'medium'}).format(new Date()).toUpperCase();
  $('#year').textContent = new Date().getFullYear();
  const [me, posts] = await Promise.all([api('/api/me'), api('/api/posts')]);
  state.authenticated = me.authenticated; state.posts = posts;
  $('#admin-button').textContent = me.authenticated ? '写文章' : '登录';
  $('#admin-button').onclick = () => state.authenticated ? edit() : $('#login-dialog').showModal();
  $('#home-link').onclick = event => { event.preventDefault(); goHome(); };
  $('#footer-home').onclick = event => { event.preventDefault(); goHome(); };
  document.querySelectorAll('[data-home-anchor]').forEach(link => link.onclick = event => { event.preventDefault(); goHome(true, link.dataset.homeAnchor); });
  $('#reader-back').onclick = () => goHome();
  $('#login-form').onsubmit = login;
  bindClose(); bindEditor(); renderArchive(); await applyRoute();
  window.addEventListener('popstate', applyRoute);
  window.addEventListener('scroll', updateReadingProgress, {passive:true});
}
init().catch(error => { $('#post-list').innerHTML = `<p class="error">${esc(error.message)}</p>`; });
