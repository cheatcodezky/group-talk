import { setupSideChat } from './side-chat.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const time = (stamp) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(stamp));
// randomUUID requires HTTPS on LAN hosts; getRandomValues also works on local HTTP.
const newMessageId = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
let token = sessionStorage.getItem('grouptalk-token');
let state, events, mode = 'chat', replyTo = null, busy = false, connected = false, serviceStopped = false, conversationView, toastTimer, renderSignature = '', approvalSignature = '', clientId = null;
const params = new URLSearchParams(location.hash.slice(1));
let joinKey = params.get('host') || params.get('invite') || '';
$('#invite-input-wrap').hidden = Boolean(joinKey);
if (params.has('host')) $('#join-name').placeholder = '留空时默认叫房主';

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
const sideChat = setupSideChat({ $, api, toast, esc, rich, newMessageId });

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
      <div class="message-content">${rich(message.text)}</div>
      ${files.length ? `<div class="source-files" aria-label="来源对话产出">${files.map((file) =>
        `<button type="button" data-source-message="${esc(message.id)}" data-source-index="${file.index}" data-source-name="${esc(file.name)}">下载 ${esc(file.label)}${file.label === file.name ? '' : ` · ${esc(file.name)}`}</button>`).join('')}</div>` : ''}
      ${task && isAgent ? `<div class="message-context"><span>◌</span> 已结合 ${task.contextCount || 0} 条新讨论${task.status === 'cancelled' ? ' · 本回合已停止' : ''}</div>` : ''}
      <div class="message-actions">
        <button data-reply="${esc(message.id)}">回复</button>
        <button data-note-message="${esc(message.id)}">留作共同记录</button>
        ${message.role !== 'system' ? `<button data-side-anchor="${esc(message.id)}">从此处侧聊</button>` : ''}
      </div>
    </div>
  </article>`;
}
async function downloadSourceFile(button) {
  const response = await fetch(`/api/source-files/${button.dataset.sourceMessage}/${button.dataset.sourceIndex}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error((await response.json()).error || '来源文件下载失败');
  const url = URL.createObjectURL(await response.blob());
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
  conversationView ??= sourceCount ? 'source' : 'room';
  const showingSource = conversationView === 'source';
  const messages = state.messages.filter((message) => Boolean(message.history) === showingSource);
  $('#conversation-views').hidden = !sourceCount;
  $('#source-count').textContent = sourceCount;
  document.querySelectorAll('[data-conversation-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.conversationView === conversationView));
  });
  const signature = JSON.stringify(showingSource ? [conversationView, messages.length]
    : [conversationView, messages.length, state.tasks.map((task) => [task.id, task.contextCount, task.status]), state.runtime.text, state.runtime.state, serviceStopped]);
  if (signature !== renderSignature) {
    renderSignature = signature;
    const scroll = $('#conversation-scroll');
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
    const hadMessages = Boolean($('#messages').children.length);
    $('#welcome').hidden = showingSource || messages.length > 0;
    $('#messages').innerHTML = messages.map(renderMessage).join('');
    const active = state.tasks.find((task) => task.id === state.runtime.taskId);
    $('#live-message').innerHTML = !showingSource && working ? `<article class="message agent-message"><span class="avatar codex-avatar" aria-hidden="true">✳</span><div class="message-body"><div class="message-meta"><span class="message-name">Codex</span><span class="message-tag">${active?.mode === 'execute' ? '正在实现' : '一起分析'}</span></div><div class="message-content">${state.runtime.text ? rich(state.runtime.text) : '<span class="thinking" aria-label="正在思考"><i></i><i></i><i></i></span>'}</div><div class="message-context">${esc(active?.progress.at(-1)?.text.split('\n')[0] || `正在结合 ${active?.contextCount || 0} 条新讨论`)}</div></div></article>` : '';
    if (nearBottom || !hadMessages) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }
  $('#settings-button').hidden = state.me.role !== 'host';
  $('#settings-button').disabled = serviceStopped;
  $('#stop-service').hidden = !state.canStop || serviceStopped;
  $('#share-button').hidden = state.me.role !== 'host';
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
    conversationView = 'room';
    render();
    $('#conversation-scroll').scrollTop = $('#conversation-scroll').scrollHeight;
  } catch (error) { toast(error.message); } finally { busy = false; updateComposer(); $('#message-input').focus(); }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.hasAttribute('data-close')) button.closest('dialog').close();
    if (button.dataset.conversationView) {
      conversationView = button.dataset.conversationView;
      render();
      $('#conversation-scroll').scrollTop = $('#conversation-scroll').scrollHeight;
    }
    if (button.dataset.sourceMessage) await downloadSourceFile(button);
    if (button.dataset.mode) { mode = button.dataset.mode; clientId = null; updateComposer(); $('#message-input').focus(); }
    if (button.dataset.reply) { replyTo = button.dataset.reply; updateComposer(); $('#message-input').focus(); }
    if (button.id === 'clear-reply') { replyTo = null; updateComposer(); }
    if (button.dataset.cancel) await api(`/api/tasks/${button.dataset.cancel}/cancel`, {});
    if (button.dataset.approval) {
      button.disabled = true;
      try { await api(`/api/approvals/${button.dataset.approval}`, { decision: button.dataset.decision }); }
      finally { button.disabled = false; }
    }
    if (button.dataset.toggleNote) await api(`/api/notes/${button.dataset.toggleNote}`, { done: button.dataset.done === 'true' });
    if (button.id === 'recover-queue') { if (confirm('请先检查上次任务的工作区变更。继续后不会重跑状态不明的任务，后续排队任务将开始执行。')) await api('/api/recover', {}); }
    if (button.dataset.noteMessage) { $('#note-text').value = state.messages.find((message) => message.id === button.dataset.noteMessage).text.slice(0, 1000); modal('#note-dialog'); }
    if (button.dataset.sideAnchor) sideChat.start(state.messages.find((message) => message.id === button.dataset.sideAnchor));
    if (button.dataset.viewSide) sideChat.open(button.dataset.viewSide);
  } catch (error) { toast(error.message); }
});
$('#example-button').onclick = () => { $('#message-input').value = '我们先对齐一下：这个需求最想解决什么问题？'; updateComposer(); $('#message-input').focus(); };
$('#add-note').onclick = () => { $('#note-text').value = ''; modal('#note-dialog'); };
$('#show-notes').onclick = () => {
  sideChat.close();
  $('#context-panel').classList.add('open');
};
$('#close-notes').onclick = () => $('#context-panel').classList.remove('open');
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
$('#identity-button').onclick = () => { $('#identity-detail').textContent = `${state.me.name} · ${state.me.role === 'host' ? '房主' : '协作者'}`; modal('#identity-dialog'); };
$('#leave-button').onclick = () => { events?.close(); sessionStorage.removeItem('grouptalk-token'); location.reload(); };
if (token) enter().catch((error) => { sessionStorage.removeItem('grouptalk-token'); token = null; $('#join-error').textContent = error.message; });
