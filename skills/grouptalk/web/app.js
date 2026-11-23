import { setupSideChat } from './side-chat.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const time = (stamp) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(stamp));
// randomUUID requires HTTPS on LAN hosts; getRandomValues also works on local HTTP.
const newMessageId = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
let token = sessionStorage.getItem('grouptalk-token');
let state, events, mode = 'chat', replyTo = null, busy = false, connected = false, serviceStopped = false, conversationView = 'overview', toastTimer, renderSignature = '', approvalSignature = '', clientId = null;
const params = new URLSearchParams(location.hash.slice(1));
let joinKey = params.get('host') || params.get('invite') || '';
$('#invite-input-wrap').hidden = Boolean(joinKey);
if (params.has('host')) $('#join-name').placeholder = '留空时默认叫房主';
else {
  try { $('#join-name').value = localStorage.getItem('grouptalk-last-name') || ''; } catch { /* Browser storage is optional. */ }
}
if (params.has('review')) {
  $('#join-form').hidden = true;
  $('#review-link-hint').hidden = false;
}

async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  if (serviceStopped) throw new Error('GroupTalk 服务已停止');
  const response = await fetch(path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'content-type': 'application/json' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 5500); }
function modal(selector) { $(selector).showModal(); }
function rich(text) {
  const inline = (line) => esc(line).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return String(text || '').split(/```[^\n]*\n([\s\S]*?)```/g).map((part, index) => index % 2 ? `<pre><code>${esc(part)}</code></pre>` : part.split(/\n\n+/).filter(Boolean).map((paragraph) => /^#{1,4} /.test(paragraph) && !paragraph.includes('\n') ? `<h3>${inline(paragraph.replace(/^#{1,4} /, ''))}</h3>` : `<p>${inline(paragraph)}</p>`).join('')).join('');
}
const memberColor = (id) => Math.max(0, state.members.findIndex((member) => member.id === id)) % 4;
const avatar = (id, name) => `<span class="avatar color-${memberColor(id)}" aria-hidden="true">${esc([...name][0] || '人')}</span>`;
const statusLabels = { awaiting_approval: '待房主审批', queued: '等待中', starting: '提交中', running: '进行中', completed: '已完成', cancelled: '已停止', failed: '未完成', needs_review: '需要检查' };
const app = $('#app');
const membersPanel = { element: $('#members-panel'), toggle: $('#toggle-members'), drawer: matchMedia('(max-width: 620px)'), collapsed: 'members-collapsed' };
const overviewPanel = { element: $('#context-panel'), toggle: $('#show-notes'), drawer: matchMedia('(max-width: 920px)'), collapsed: 'overview-collapsed' };
const panels = [membersPanel, overviewPanel];

function panelIsOpen({ element, drawer, collapsed }) {
  return !element.hidden && (drawer.matches ? element.classList.contains('open') : !app.classList.contains(collapsed));
}

function updatePanelButtons() {
  for (const panel of panels) panel.toggle.setAttribute('aria-expanded', String(panelIsOpen(panel)));
}

function setPanelOpen(panel, open) {
  if (panel.drawer.matches) panel.element.classList.toggle('open', open);
  else {
    app.classList.toggle(panel.collapsed, !open);
    sessionStorage.setItem(`grouptalk-${panel.collapsed}`, String(!open));
  }
  updatePanelButtons();
}

for (const panel of panels) {
  app.classList.toggle(panel.collapsed, sessionStorage.getItem(`grouptalk-${panel.collapsed}`) === 'true');
  panel.drawer.addEventListener('change', () => {
    panel.element.classList.remove('open');
    updatePanelButtons();
  });
}
updatePanelButtons();

const sideChat = setupSideChat({ $, api, toast, esc, rich, newMessageId, onVisibilityChange(open) {
  if (open) for (const panel of panels) panel.element.classList.remove('open');
  updatePanelButtons();
} });

function sourceFileAttributes(messageId, file) {
  return `data-source-message="${esc(messageId)}" data-source-index="${file.index}" data-source-name="${esc(file.name)}"`;
}

const thumbnail = '<img alt="" decoding="async" hidden><span class="source-image-status" aria-hidden="true">加载缩略图</span>';

function sourceFileActions(message, files) {
  return files.map((file) => {
    const source = sourceFileAttributes(message.id, file);
    const title = file.label === file.name ? file.name : `${file.label} · ${file.name}`;
    const download = `<button type="button" ${source} aria-label="下载 ${esc(file.name)}">下载</button>`;
    if (file.imageType) return `<span class="source-file-actions source-image-actions"><button type="button" class="source-thumbnail" ${source} data-source-image aria-label="放大 ${esc(title)}">` +
      `${thumbnail}</button>${download}</span>`;
    if (!file.preview) return `<button type="button" ${source}>下载 ${esc(title)}</button>`;
    return `<span class="source-file-actions"><button type="button" ${source} data-preview="${esc(file.preview)}">打开 ${esc(title)}</button>${download}</span>`;
  }).join('');
}

function reviewMaterial(file) {
  const source = sourceFileAttributes(file.messageId, file);
  const kind = file.imageType ? '图片' : { html: 'HTML', markdown: 'Markdown' }[file.preview] || '附件';
  const action = file.imageType ? 'data-source-image' : file.preview ? `data-preview="${esc(file.preview)}"` : '';
  const verb = file.imageType ? '放大' : file.preview ? '预览' : '下载';
  return `<li class="review-material">
    ${file.imageType ? `<button type="button" class="review-thumbnail" ${source} ${action} aria-label="放大 ${esc(file.label)}">${thumbnail}</button>` : ''}
    <div class="review-material-body">
      <small>${kind}</small><p title="${esc(file.name)}">${esc(file.label)}</p>
      <div class="review-material-actions">
        ${file.imageType ? '' : `<button type="button" ${source} ${action} aria-label="${verb} ${esc(file.label)}">${verb}</button>`}
        ${action ? `<button type="button" ${source} aria-label="下载 ${esc(file.label)}">下载</button>` : ''}
      </div>
    </div>
  </li>`;
}

let summarySignature, coreSignature, materialsSignature;
function renderOverview() {
  const { title, goal, points = [], files = [], messageId, task, coreItems = [] } = state.overview || {};
  const summaryKey = JSON.stringify([title, goal, points, task, messageId]);
  if (summaryKey !== summarySignature) {
    summarySignature = summaryKey;
    $('#review-summary').innerHTML = `
      ${title ? `<p class="overview-subject">${esc(title)}</p>` : ''}
      ${goal ? `<p class="overview-goal">${esc(goal)}</p>` : ''}
      ${points.length ? `<dl class="overview-points">${points.map(({ label, text }) =>
        `<div><dt>${esc(label)}</dt><dd>${esc(text)}</dd></div>`).join('')}</dl>` : ''}
      ${!title && !goal && !points.length ? '<p class="overview-empty">共享对话有内容后，会在这里提取摘要。</p>' : ''}
      ${task ? `<p class="overview-current"><strong>${esc(statusLabels[task.status])}</strong> ${esc(task.request)}</p>` : ''}
      ${messageId && (title || goal || points.length) ? `<button type="button" class="overview-jump" data-overview-message="${esc(messageId)}">查看摘要来源</button>` : ''}`;
  }
  const core = JSON.stringify(coreItems);
  if (core !== coreSignature) {
    coreSignature = core;
    const cards = coreItems.map((item) => `
      <article class="core-info-card" data-core-id="${esc(item.id)}">
        <div class="core-info-kind">${esc({ conclusion: '结论', proposal: '建议', question: '待确认', action: '行动项', progress: '进展', artifact: '素材' }[item.kind])}</div>
        <h4>${esc(item.title)}</h4><div class="message-content">${rich(item.content)}</div>
        <div class="core-info-meta">${time(item.updatedAt)} · 第 ${item.revision} 版 · ${esc(item.requestedBy)} 请求</div>
        <button type="button" class="overview-jump" data-overview-message="${esc(item.messageId)}">查看来源</button>
      </article>`).join('');
    $('#review-core-items').innerHTML = cards;
    $('#sidebar-core-items').innerHTML = cards;
  }
  const materials = JSON.stringify(files);
  if (materials !== materialsSignature) {
    materialsSignature = materials;
    $('#review-files-count').textContent = files.length || '';
    $('#review-files').innerHTML = files.length ? `<ul class="review-materials">${files.map(reviewMaterial).join('')}</ul>` :
      '<p class="overview-empty">共享对话里的文档、图片和附件会出现在这里。</p>';
    syncSourceThumbnails();
  }
  $('#review-core-info').hidden = !coreItems.length;
  $('#sidebar-core-info').hidden = conversationView === 'overview' || !coreItems.length;
}

function renderMessage(message) {
  const task = state.tasks.find((task) => task.id === message.taskId);
  const quote = message.replyTo && state.messages.find((item) => item.id === message.replyTo);
  const isAgent = message.role === 'agent';
  const files = state.sourceFiles?.[message.id] || [];
  const shared = message.sideChat ? `<div class="side-source">
    <button type="button" class="side-link" data-view-side="${esc(message.sideChat.id)}">Codex 侧聊 · ${esc(message.sideChat.title)}</button>
    <div class="quote">${esc(message.sideChat.question)}</div>
  </div>` : '';
  return `<article class="message ${isAgent ? 'agent-message' : ''} ${message.role === 'system' ? 'system-message' : ''} ${message.history ? 'history-message' : ''}" id="message-${esc(message.id)}">
    ${isAgent ? '<span class="avatar codex-avatar" aria-hidden="true">✳</span>' : avatar(message.authorId, message.authorName)}
    <div class="message-body">
      <div class="message-meta">
        <span class="message-name">${esc(message.authorName)}</span>
        ${message.authorId === state.me.id ? '<span class="message-tag">我</span>' : ''}
        <time class="message-time">${time(message.createdAt)}</time>
        ${message.mode && message.mode !== 'chat' ? `<span class="message-tag">${message.mode === 'execute' ? '实现任务' : '邀请分析'}</span>` : ''}
        ${message.trigger === 'auto' ? '<span class="message-tag">智能参与</span>' : ''}
      </div>
      ${quote ? `<div class="quote">${esc(quote.authorName)}：${esc(quote.text.slice(0, 180))}</div>` : ''}
      ${shared}
      <div class="message-content">${rich(message.coreUpdate ? message.text.replace(message.coreUpdate.raw, '') : message.text)}</div>
      ${message.coreUpdate ? '<div class="message-context">已更新右侧核心信息</div>' : ''}
      ${files.length ? `<div class="source-files" aria-label="对话产物">${sourceFileActions(message, files)}</div>` : ''}
      ${task && isAgent ? `<div class="message-context"><span>◌</span> 已结合 ${task.contextCount || 0} 条新讨论${task.status === 'cancelled' ? ' · 本回合已停止' : ''}</div>` : ''}
      <div class="message-actions">
        <button data-reply="${esc(message.id)}">回复</button>
        <button data-note-message="${esc(message.id)}">留作共同记录</button>
        ${message.role !== 'system' ? `<button data-side-anchor="${esc(message.id)}">从此处侧聊</button>` : ''}
      </div>
    </div>
  </article>`;
}
const sourceFileUrl = (button) => `/api/source-files/${button.dataset.sourceMessage}/${button.dataset.sourceIndex}`;

async function openSourcePreview(button) {
  const { url } = await api(`${sourceFileUrl(button)}/preview`);
  const dialog = $('#source-preview-dialog');
  const frame = $('#source-preview-frame');
  $('#source-preview-title').textContent = button.dataset.sourceName;
  frame.title = button.dataset.sourceName;
  frame.setAttribute('sandbox', button.dataset.preview === 'html' ? 'allow-scripts' : 'allow-popups allow-popups-to-escape-sandbox');
  frame.src = url;
  if (!dialog.open) dialog.showModal();
}

$('#source-preview-dialog').addEventListener('close', () => { $('#source-preview-frame').removeAttribute('src'); });

async function sourceFileResponse(button) {
  const response = await fetch(sourceFileUrl(button), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error((await response.json()).error || '来源文件读取失败');
  return response.blob();
}

const imageUrls = new Map();
function sourceImageUrl(button) {
  const path = sourceFileUrl(button);
  if (!imageUrls.has(path)) {
    const pending = sourceFileResponse(button).then((blob) => URL.createObjectURL(blob));
    imageUrls.set(path, pending);
    pending.catch(() => { if (imageUrls.get(path) === pending) imageUrls.delete(path); });
  }
  return imageUrls.get(path);
}

async function showSourceThumbnail(button) {
  const image = button.querySelector('img');
  const status = button.querySelector('.source-image-status');
  try {
    image.src = await sourceImageUrl(button);
    await image.decode();
    image.hidden = false;
    status.hidden = true;
  } catch {
    status.textContent = '缩略图无法显示';
  }
}

const imageObserver = new IntersectionObserver((entries) => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting) continue;
    imageObserver.unobserve(target);
    void showSourceThumbnail(target);
  }
}, { rootMargin: '160px' });

function syncSourceThumbnails() {
  imageObserver.disconnect();
  const buttons = document.querySelectorAll('#messages [data-source-image], #review-files [data-source-image]');
  const visible = new Set([...buttons].map(sourceFileUrl));
  for (const [path, pending] of imageUrls) {
    if (visible.has(path)) continue;
    imageUrls.delete(path);
    void pending.then((url) => URL.revokeObjectURL(url), () => {});
  }
  for (const button of buttons) {
    if (button.querySelector('img').hidden) imageObserver.observe(button);
  }
}

const imageDialog = $('#source-image-dialog');
const previewImage = $('#source-image-full');
async function openSourceImage(button) {
  previewImage.src = await sourceImageUrl(button);
  await previewImage.decode();
  $('#source-image-title').textContent = button.dataset.sourceName;
  previewImage.alt = button.dataset.sourceName;
  if (!imageDialog.open) imageDialog.showModal();
}
imageDialog.addEventListener('close', () => previewImage.removeAttribute('src'));

async function downloadSourceFile(button) {
  const url = URL.createObjectURL(await sourceFileResponse(button));
  const link = document.createElement('a');
  link.href = url;
  link.download = button.dataset.sourceName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function renderApprovals() {
  const { approvals, pendingApprovalCount } = state;
  $('#approval-banner').hidden = !pendingApprovalCount;
  $('#approval-status').textContent = `${pendingApprovalCount} 项请求等待房主审批`;
  $('#show-approvals').hidden = !approvals.length;
  if (!approvals.length && $('#approval-dialog').open) $('#approval-dialog').close();
  const signature = JSON.stringify(approvals);
  if (signature === approvalSignature) return;
  approvalSignature = signature;
  $('#approval-list').innerHTML = approvals.map((approval) => `<article class="approval-card">
    <h3>${esc(approval.kind)} · ${esc(approval.authorName)}</h3>
    ${approval.reason ? `<p>${esc(approval.reason)}</p>` : ''}
    <pre>${esc(approval.detail)}</pre>
    ${approval.cwd ? `<p>工作目录：<code>${esc(approval.cwd)}</code></p>` : ''}
    ${approval.scope ? `<p>权限范围</p><pre>${esc(approval.scope)}</pre>` : ''}
    ${approval.kind === '命令执行' ? '<p>批准后，该命令可在沙箱限制之外执行。</p>' : ''}
    <div class="dialog-actions">
      <button type="button" class="text-button" data-approval="${esc(approval.id)}" data-decision="decline">拒绝</button>
      <button type="button" class="primary" data-approval="${esc(approval.id)}" data-decision="accept">允许本次</button>
    </div>
  </article>`).join('');
}
function render() {
  if (!state) return;
  renderOverview();
  $('#room-title').textContent = state.title;
  $('#room-topic').textContent = state.topic;
  document.title = `${state.title} · GroupTalk`;
  $('#member-count').textContent = `${state.members.filter((member) => member.online).length} 在线`;
  $('#members').innerHTML = state.members.map((member) => `<div class="member-row">
    ${avatar(member.id, member.name)}
    <div><strong>${esc(member.name)}${member.id === state.me.id ? ' · 我' : ''}</strong>
      <small>${member.role === 'host' ? '房主' : '协作者'}</small>
      ${member.network ? `<small class="member-network">IP ${esc(member.network.ip)}</small><small class="member-network">MAC ${esc(member.network.mac || '未识别')}</small>` : ''}
    </div>${member.online ? '<span class="status-dot"></span>' : ''}
    ${state.me.role === 'host' ? `<button type="button" class="member-rename" data-rename-member="${esc(member.id)}" aria-label="修改 ${esc(member.name)} 的用户名">改名</button>` : ''}
  </div>`).join('');
  $('#identity-button').innerHTML = `${avatar(state.me.id, state.me.name)}<span>${esc(state.me.name)}</span><span>⌄</span>`;
  $('#connection-label').textContent = serviceStopped ? '服务已停止' : connected ? '已连接' : '正在重连';
  $('#connection-dot').classList.toggle('offline', !connected);
  $('#connection-banner').hidden = connected && !state.runtime.error;
  $('#connection-banner').textContent = serviceStopped ? 'GroupTalk 服务已停止。房主重新开房后，请打开新的邀请链接或刷新此页。'
    : !connected ? '连接已中断，正在自动重连。尚未发送的内容会保留。' : state.runtime.error;
  renderApprovals();
  const working = !serviceStopped && state.runtime.state === 'working';
  $('#agent-presence').textContent = working ? '正在与大家协作' : serviceStopped || state.runtime.state === 'disconnected' ? '连接已断开' : state.settings.jevEnabled ? '正在倾听讨论' : '等待 @Codex';
  $('#agent-dot').classList.toggle('offline', serviceStopped || state.runtime.state === 'disconnected');
  const pending = state.messages.filter((message) => message.role === 'user' && !message.history && message.seq > state.deliveredSeq).length;
  $('#context-status').textContent = pending ? `${pending} 条讨论待补充 · 下次参与时一并交给 Codex` : '当前讨论已同步给 Codex · 新消息会在下次参与时补充';
  const sourceCount = state.messages.filter((message) => message.history).length;
  const showingOverview = conversationView === 'overview';
  const showingSource = conversationView === 'source';
  const messages = state.messages.filter((message) => Boolean(message.history) === showingSource);
  $('#review-view').hidden = !showingOverview;
  $('#conversation-scroll').hidden = showingOverview;
  $('#composer-area').hidden = conversationView !== 'room';
  $('.topic-bar').hidden = showingOverview && Boolean(state.overview?.goal);
  $('[data-conversation-view="source"]').hidden = !sourceCount;
  $('#source-count').textContent = sourceCount;
  document.querySelectorAll('[data-conversation-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.conversationView === conversationView));
  });
  const signature = JSON.stringify(showingSource ? [conversationView, messages.length]
    : [conversationView, messages.length, state.tasks.map((task) => [task.id, task.contextCount, task.status]), state.runtime.text, state.runtime.state, serviceStopped]);
  if (!showingOverview && signature !== renderSignature) {
    renderSignature = signature;
    const scroll = $('#conversation-scroll');
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
    const hadMessages = Boolean($('#messages').children.length);
    $('#welcome').hidden = showingSource || messages.length > 0;
    $('#messages').innerHTML = messages.map(renderMessage).join('');
    syncSourceThumbnails();
    const active = state.tasks.find((task) => task.id === state.runtime.taskId);
    $('#live-message').innerHTML = !showingSource && working ? `<article class="message agent-message"><span class="avatar codex-avatar" aria-hidden="true">✳</span><div class="message-body"><div class="message-meta"><span class="message-name">Codex</span><span class="message-tag">${active?.mode === 'execute' ? '正在实现' : '一起分析'}</span></div><div class="message-content">${state.runtime.text ? rich(state.runtime.text) : '<span class="thinking" aria-label="正在思考"><i></i><i></i><i></i></span>'}</div><div class="message-context">${esc(active?.progress.at(-1)?.text.split('\n')[0] || `正在结合 ${active?.contextCount || 0} 条新讨论`)}</div></div></article>` : '';
    if (nearBottom || !hadMessages) scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'instant' });
  }
  $('#settings-button').hidden = state.me.role !== 'host';
  $('#settings-button').disabled = serviceStopped;
  $('#stop-service').hidden = !state.canStop || serviceStopped;
  $('#share-button').hidden = state.me.role !== 'host';
  $('#show-review-links').hidden = state.me.role !== 'host' || serviceStopped;
  $('#note-count').textContent = state.notes.length;
  const noteLabels = { decision: '已形成的结论', question: '待确认的问题', action: '下一步行动' };
  $('#notes').innerHTML = state.notes.length ? state.notes.map((note) => `<article class="note-card ${esc(note.kind)} ${note.done ? 'done' : ''}"><div class="note-kind"><span>${{ decision: '◇', question: '？', action: '↗' }[note.kind]}</span>${noteLabels[note.kind]}</div><p>${esc(note.text)}</p><div class="note-author"><span>${esc(note.authorName)} · ${time(note.createdAt)}</span>${note.authorId === state.me.id || state.me.role === 'host' ? `<button data-toggle-note="${esc(note.id)}" data-done="${!note.done}">${note.done ? '重新打开' : '标记完成'}</button>` : ''}</div></article>`).join('') : '<div class="empty-notes"><span class="empty-icon">▱</span><h3>讨论的成果，值得被留下</h3><p>记录已形成的结论、还没解决的问题，<br>以及接下来要一起做的事。</p></div>';
  const activeCount = state.tasks.filter((task) => ['awaiting_approval', 'queued', 'starting', 'running'].includes(task.status)).length;
  $('#task-count').textContent = activeCount ? `${activeCount} 项待完成` : '';
  $('#queue-warning').innerHTML = state.queuePaused ? `<div class="queue-warning">执行状态需要检查，队列已暂停。${state.me.role === 'host' ? '<button id="recover-queue">我已检查上次结果，继续队列</button>' : '请房主检查上次任务结果。'}</div>` : '';
  $('#tasks').innerHTML = state.tasks.length ? state.tasks.slice(-6).reverse().map((task) => `<article class="task-card"><div class="task-top"><span class="task-status ${esc(task.status)}"></span>${statusLabels[task.status]}<span>· ${task.mode === 'execute' ? '实现' : task.trigger === 'auto' ? '智能参与' : '分析'}</span></div><div class="task-title">${esc(task.request)}</div><div class="task-bottom"><span>${esc(task.authorName)} · ${time(task.createdAt)}</span>${['awaiting_approval', 'queued', 'running'].includes(task.status) && (task.authorId === state.me.id || state.me.role === 'host') ? `<button data-cancel="${esc(task.id)}">${task.status === 'running' ? '停止' : '取消请求'}</button>` : ''}</div>${task.error ? `<div class="task-error">${esc(task.error)}</div>` : ''}${task.progress?.length ? `<details class="task-detail"><summary>查看执行过程 · ${task.progress.length} 项</summary>${task.progress.map((event) => `<pre>${esc(event.text)}</pre>`).join('')}</details>` : ''}</article>`).join('') : '<div class="empty-task">现在可以自在讨论。<br>需要更多视角时，@Codex 一起参与。</div>';
  $('#jev-switch').setAttribute('aria-checked', String(state.settings.jevEnabled));
  $('#jev-switch').setAttribute('aria-label', state.settings.jevEnabled ? '关闭 Jev 智能参与' : '开启 Jev 智能参与');
  $('#jev-switch').disabled = state.me.role !== 'host';
  $('#judge-description').textContent = state.settings.jevEnabled ? 'Jev 判断合适时机，Codex 简短补充或澄清。' : '仅在 @Codex 时参与讨论。大家可以先充分交流。';
  $('#judge-detail').textContent = state.judge.note || (!state.judge.ready ? '房主配置 Jev 密钥后可开启，不影响点名协作。' : '先倾听，再决定是否参与。');
  $('#judge-status').textContent = state.judge.status === 'checking' ? '正在判断时机' : state.settings.jevEnabled ? '智能倾听中' : state.judge.status === 'degraded' ? '已降级为点名模式' : '点名模式';
  $('#engine-details').innerHTML = `<p>工作区：${esc(state.workspace)}</p><p>模型：${esc(state.model)}</p>${state.shellRestricted ? '<p>检测到已有 Codex 命令规则，共享房间已暂停使用 shell。</p>' : ''}<p>协作线程：${esc(state.threadId)}</p>${state.sourceThreadId ? `<p>来源线程：${esc(state.sourceThreadId)}<br>当前讨论保存在独立协作分支。</p>` : ''}<p>Codex 输入 ${state.usage.inputTokens.toLocaleString()} · 输出 ${state.usage.outputTokens.toLocaleString()} Token<br>缓存输入 ${state.usage.cachedInputTokens.toLocaleString()} Token</p><p>Jev ${state.judge.calls} 次 · ${state.judge.inputTokens.toLocaleString()} 输入 Token · 估算 $${state.judge.cost.toFixed(6)}</p>`;
  updateComposer();
  sideChat.update(state);
}
function updateComposer() {
  const allowed = state?.me.role === 'host' || state?.settings.allowExecution;
  $('[data-mode=execute]').disabled = !allowed;
  if (mode === 'execute' && !allowed) mode = 'chat';
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  $('#message-input').placeholder = mode === 'chat' ? '分享你的想法，也可以 @Codex 邀请它参与…' : mode === 'ask' ? '邀请 Codex 结合大家的讨论，提供分析、信息或建议…' : '说明要实现的具体任务，Codex 会在共享工作区执行…';
  $('#composer-hint').textContent = mode === 'chat' ? '消息对房间内所有人可见' : mode === 'ask' ? '会补齐未提交的讨论 · 分析模式不修改文件' : state.me.role === 'host' ? '使用受限工作区权限 · 额外权限需审批' : '本机房主批准后才会开始';
  $('#send-button').disabled = serviceStopped || busy || !$('#message-input').value.trim();
  $('#send-button').firstChild.textContent = busy ? '发送中 ' : mode === 'chat' ? '发送 ' : mode === 'ask' ? '邀请分析 ' : '提交任务 ';
  $('#reply-preview').hidden = !replyTo;
  if (replyTo) {
    const message = state.messages.find((message) => message.id === replyTo);
    $('#reply-preview').innerHTML = `<span>回复 ${esc(message?.authorName)}：${esc(message?.text.slice(0, 140))}</span><button type="button" class="icon-button" id="clear-reply" aria-label="取消引用">×</button>`;
  }
}
async function enter() {
  state = await api('/api/bootstrap');
  $('#join-screen').hidden = true; $('#app').hidden = false;
  history.replaceState(null, '', location.pathname);
  events?.close();
  events = new EventSource(`/api/events?session=${encodeURIComponent(token)}`);
  events.onopen = () => { connected = true; render(); };
  events.onerror = () => { connected = false; render(); };
  events.addEventListener('shutdown', showStopped);
  events.addEventListener('state', (event) => { state = JSON.parse(event.data); connected = true; render(); });
  render();
}
function showStopped() {
  serviceStopped = true;
  connected = false;
  events?.close();
  $('#stop-dialog').close();
  $('#settings-dialog').close();
  render();
}
$('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#join-form button'); button.disabled = true; $('#join-error').textContent = '';
  try {
    const result = await api('/api/join', { key: joinKey || $('#join-key').value.trim(), name: $('#join-name').value });
    if (result.member.role !== 'host') {
      try { localStorage.setItem('grouptalk-last-name', result.member.name); } catch { /* Browser storage is optional. */ }
    }
    token = result.token; sessionStorage.setItem('grouptalk-token', token); await enter();
  } catch (error) { $('#join-error').textContent = error.message; } finally { button.disabled = false; }
});
$('#message-input').addEventListener('input', () => {
  clientId = null;
  const input = $('#message-input'); input.style.height = 'auto'; input.style.height = `${Math.min(170, input.scrollHeight)}px`;
  updateComposer();
});
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('#send-button').disabled) $('#message-form').requestSubmit(); }
});
$('#message-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (busy || !$('#message-input').value.trim()) return;
  busy = true; updateComposer(); clientId ||= newMessageId();
  try {
    await api('/api/messages', { text: $('#message-input').value, mode, replyTo, clientId });
    $('#message-input').value = ''; $('#message-input').style.height = 'auto'; replyTo = null; clientId = null;
    render();
    if (conversationView === 'room') $('#conversation-scroll').scrollTop = $('#conversation-scroll').scrollHeight;
  } catch (error) { toast(error.message); } finally {
    busy = false;
    updateComposer();
    if (conversationView === 'room') $('#message-input').focus();
  }
});

function selectConversation(view) {
  if (conversationView === view) return;
  conversationView = view;
  render();
  if (view === 'overview') return;
  const scroll = $('#conversation-scroll');
  scroll.scrollTo({ top: view === 'source' ? 0 : scroll.scrollHeight, behavior: 'instant' });
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.hasAttribute('data-close')) button.closest('dialog').close();
    if (button.dataset.conversationView) selectConversation(button.dataset.conversationView);
    if (button.dataset.overviewMessage) {
      const found = state.messages.find(({ id }) => id === button.dataset.overviewMessage);
      if (found) {
        conversationView = found.history ? 'source' : 'room';
        if (overviewPanel.drawer.matches) setPanelOpen(overviewPanel, false);
        render();
        const source = document.getElementById(`message-${found.id}`);
        if (source) {
          source.tabIndex = -1;
          source.focus({ preventScroll: true });
          source.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
      }
    }
    if (button.dataset.sourceMessage) {
      button.disabled = true;
      try {
        if (button.hasAttribute('data-source-image')) await openSourceImage(button);
        else if (button.dataset.preview) await openSourcePreview(button);
        else await downloadSourceFile(button);
      } finally { button.disabled = false; }
    }
    if (button.dataset.mode) { mode = button.dataset.mode; clientId = null; updateComposer(); $('#message-input').focus(); }
    if (button.dataset.reply) {
      replyTo = button.dataset.reply;
      selectConversation('room');
      updateComposer();
      $('#message-input').focus();
    }
    if (button.id === 'clear-reply') { replyTo = null; updateComposer(); }
    if (button.dataset.cancel) await api(`/api/tasks/${button.dataset.cancel}/cancel`, {});
    if (button.dataset.approval) {
      button.disabled = true;
      try { await api(`/api/approvals/${button.dataset.approval}`, { decision: button.dataset.decision }); }
      finally { button.disabled = false; }
    }
    if (button.dataset.toggleNote) await api(`/api/notes/${button.dataset.toggleNote}`, { done: button.dataset.done === 'true' });
    if (button.dataset.renameMember) {
      const member = state.members.find(({ id }) => id === button.dataset.renameMember);
      if (!member) return;
      $('#rename-member-form').dataset.memberId = member.id;
      $('#rename-member-name').value = member.name;
      $('#rename-member-detail').textContent = member.network?.ip ? `IP ${member.network.ip}` : '该成员的连接地址尚未记录';
      modal('#rename-member-dialog');
    }
    if (button.dataset.revokeReview) {
      await api(`/api/review-links/${button.dataset.revokeReview}/revoke`, {});
      $('#review-link-result').hidden = true;
      renderActiveReviews((await api('/api/review-links')).active);
    }
    if (button.id === 'recover-queue') { if (confirm('请先检查上次任务的工作区变更。继续后不会重跑状态不明的任务，后续排队任务将开始执行。')) await api('/api/recover', {}); }
    if (button.dataset.noteMessage) { $('#note-text').value = state.messages.find((message) => message.id === button.dataset.noteMessage).text.slice(0, 1000); modal('#note-dialog'); }
    if (button.dataset.sideAnchor) sideChat.start(state.messages.find((message) => message.id === button.dataset.sideAnchor));
    if (button.dataset.viewSide) sideChat.open(button.dataset.viewSide);
  } catch (error) { toast(error.message); }
});
$('#rename-member-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#rename-member-save');
  button.disabled = true;
  try {
    await api(`/api/members/${form.dataset.memberId}/name`, { name: $('#rename-member-name').value });
    $('#rename-member-dialog').close();
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
};
$('#enter-discussion').onclick = () => {
  selectConversation('room');
  $('[data-conversation-view="room"]').focus();
};
$('#example-button').onclick = () => { $('#message-input').value = '我们先对齐一下：这个需求最想解决什么问题？'; updateComposer(); $('#message-input').focus(); };
$('#add-note').onclick = () => { $('#note-text').value = ''; modal('#note-dialog'); };
membersPanel.toggle.onclick = () => {
  const open = !panelIsOpen(membersPanel);
  if (open && membersPanel.drawer.matches) {
    sideChat.close();
    setPanelOpen(overviewPanel, false);
  }
  setPanelOpen(membersPanel, open);
};
overviewPanel.toggle.onclick = () => {
  const open = !panelIsOpen(overviewPanel);
  if (open) {
    sideChat.close();
    if (membersPanel.drawer.matches) setPanelOpen(membersPanel, false);
  }
  setPanelOpen(overviewPanel, open);
};
$('#close-members').onclick = () => { setPanelOpen(membersPanel, false); membersPanel.toggle.focus(); };
$('#close-notes').onclick = () => { setPanelOpen(overviewPanel, false); overviewPanel.toggle.focus(); };
$('#show-approvals').onclick = () => modal('#approval-dialog');
$('#settings-button').onclick = () => { $('#setting-title').value = state.title; $('#setting-topic').value = state.topic; $('#setting-execution').checked = state.settings.allowExecution; modal('#settings-dialog'); };
$('#stop-service').onclick = () => modal('#stop-dialog');
$('#confirm-stop-service').onclick = async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api('/api/stop', {});
    showStopped();
  } catch (error) {
    if (!serviceStopped) toast(error.message);
  } finally { button.disabled = false; }
};
$('#settings-form').onsubmit = async (event) => { event.preventDefault(); try { await api('/api/settings', { title: $('#setting-title').value, topic: $('#setting-topic').value, allowExecution: $('#setting-execution').checked }); $('#settings-dialog').close(); toast('房间设置已更新'); } catch (error) { toast(error.message); } };
$('#note-form').onsubmit = async (event) => { event.preventDefault(); try { await api('/api/notes', { kind: $('#note-kind').value, text: $('#note-text').value }); $('#note-dialog').close(); } catch (error) { toast(error.message); } };
$('#jev-switch').onclick = async () => { try { await api('/api/settings', { jevEnabled: !state.settings.jevEnabled }); } catch (error) { toast(error.message); } };
let inviteLinks = [];
function displayInvitation(result) {
  inviteLinks = result.links;
  $('#share-address').innerHTML = inviteLinks.map((link, index) => `<option value="${index}">${esc(link.label)}</option>`).join('');
  updateInvitationAddress();
}
function updateInvitationAddress() {
  const link = inviteLinks[Number($('#share-address').value) || 0];
  $('#share-link').value = link.url;
  $('#share-address-hint').textContent = link.localOnly ? '此地址仅适合本机试用。邀请其他设备请选择局域网地址。' : '请选择同伴可以访问的网络。优先列出本机的实体网卡地址。';
}
$('#share-address').onchange = updateInvitationAddress;
$('#share-button').onclick = async () => { try { displayInvitation(await api('/api/invite')); modal('#share-dialog'); } catch (error) { toast(error.message); } };
$('#copy-link').onclick = async () => { try { await navigator.clipboard.writeText($('#share-link').value); toast('邀请链接已复制'); } catch { $('#share-link').select(); document.execCommand('copy'); toast('链接已选中，可直接复制'); } };
$('#rotate-invite').onclick = async () => { if (!confirm('重置后，旧邀请链接将不能加入。已加入成员继续保留身份。')) return; try { displayInvitation(await api('/api/invite/rotate', {})); toast('邀请链接已重置'); } catch (error) { toast(error.message); } };

let reviewAddresses = [];
function renderActiveReviews(active) {
  $('#active-review-links').innerHTML = active.length ? `<h3>活动评审链接</h3><ul>${active.map((item) =>
    `<li>${esc(item.ip || '尚未访问')} · ${time(item.expiresAt)} 到期
    <button type="button" class="text-button" data-revoke-review="${esc(item.id)}">撤销</button></li>`).join('')}</ul>` : '';
}
$('#show-review-links').onclick = async () => {
  try {
    const { active, links } = await api('/api/review-links');
    reviewAddresses = links;
    $('#review-address').innerHTML = links.map(({ label }, index) => `<option value="${index}">${esc(label)}</option>`).join('');
    $('#review-address-hint').textContent = links.every(({ localOnly }) => localOnly) ? '当前仅本机可用。跨设备需要 HTTPS。' : '';
    const overview = state.overview || {};
    const lines = [overview.goal, ...(overview.points || []).map(({ label, text }) => `${label}：${text}`),
      ...(overview.coreItems || []).map(({ title, content }) => `${title}\n${content}`)].filter(Boolean);
    $('#review-context').value = lines.join('\n\n').slice(0, 9000);
    $('#review-link-result').hidden = true;
    renderActiveReviews(active);
    modal('#review-links-dialog');
  } catch (error) { toast(error.message); }
};
$('#review-link-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('#issue-review-link');
  button.disabled = true;
  try {
    const address = new URL(reviewAddresses[Number($('#review-address').value)].url);
    const { token: reviewToken } = await api('/api/review-links', { context: $('#review-context').value });
    address.hash = `review=${reviewToken}`;
    $('#review-link').value = address.href;
    $('#review-link-result').hidden = false;
    renderActiveReviews((await api('/api/review-links')).active);
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
};
$('#copy-review-link').onclick = async () => {
  const field = $('#review-link');
  try { await navigator.clipboard.writeText(field.value); toast('评审链接已复制'); }
  catch { field.select(); document.execCommand('copy'); toast('评审链接已选中'); }
};
$('#identity-button').onclick = () => { $('#identity-detail').textContent = `${state.me.name} · ${state.me.role === 'host' ? '房主' : '协作者'}`; modal('#identity-dialog'); };
$('#leave-button').onclick = () => { events?.close(); sessionStorage.removeItem('grouptalk-token'); location.reload(); };
if (token) enter().catch((error) => { sessionStorage.removeItem('grouptalk-token'); token = null; $('#join-error').textContent = error.message; });
