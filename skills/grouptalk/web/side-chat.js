const labels = { queued: '等待中', running: '正在回答', failed: '未完成', cancelled: '已停止' };

export function setupSideChat({ $, api, toast, esc, rich, newMessageId }) {
  const panel = $('#side-panel');
  const toggle = $('#show-side-chat');
  const log = $('#side-messages');
  const input = $('#side-input');
  const dialog = $('#side-new-dialog');
  const titleInput = $('#side-new-title');
  const drafts = new Map();
  let state, chatId, anchorId, creation, focusOnReady, sending = false;
  let lastOverview = '', lastThread = '', lastChatId;

  function open(id, focus = false) {
    chatId = id || null;
    focusOnReady = focus;
    panel.hidden = false;
    $('#context-panel').hidden = true;
    $('#app').classList.add('side-open');
    toggle.setAttribute('aria-expanded', 'true');
    render();
  }

  function close() {
    panel.hidden = true;
    $('#context-panel').hidden = false;
    $('#app').classList.remove('side-open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  function start(anchor) {
    open(null);
    anchorId = anchor?.id ?? null;
    creation = null;
    const quote = $('#side-new-anchor');
    quote.hidden = !anchor;
    quote.textContent = anchor ? `${anchor.authorName}：${anchor.text.slice(0, 180)}` : '';
    titleInput.value = anchor ? anchor.text.trim().replace(/\s+/g, ' ').slice(0, 48) : '';
    dialog.showModal();
    titleInput.select();
  }

  function render() {
    if (!state || panel.hidden) return;
    const chats = state.sideChats || [];
    const chat = chats.find((item) => item.id === chatId);
    $('#side-overview').hidden = Boolean(chat) || Boolean(chatId);
    $('#side-thread').hidden = !chatId;
    if (!chatId) {
      const key = JSON.stringify(chats.map(({ id, title, authorName, questions }) => [id, title, authorName, questions.length, questions.at(-1)?.status]));
      if (key === lastOverview) return;
      lastOverview = key;
      $('#side-list').innerHTML = [...chats].reverse().map((entry) => `
        <button type="button" class="side-list-item" data-open-side="${esc(entry.id)}">
          <strong>${esc(entry.title)}</strong>
          <span>${esc(entry.authorName)} · ${entry.questions.length} 个问题</span>
        </button>`).join('') || '<p class="muted">还没有侧聊。也可以从某条群聊消息开启。</p>';
      return;
    }
    $('#side-title').textContent = chat?.title || '正在连接侧聊…';
    $('#side-anchor').hidden = !chat?.anchor;
    $('#side-anchor').textContent = chat?.anchor ? `${chat.anchor.authorName}：${chat.anchor.text}` : '';
    if (lastChatId !== chatId) input.value = drafts.get(chatId)?.text || '';
    $('#side-send').disabled = !chat || sending || !input.value.trim();
    input.disabled = !chat;
    if (chat && focusOnReady) {
      focusOnReady = false;
      input.focus();
    }

    const key = JSON.stringify([chatId, chat?.questions, chat?.partial]);
    if (key === lastThread) return;
    const nearBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 80;
    const switched = lastChatId !== chatId;
    lastChatId = chatId;
    lastThread = key;
    log.innerHTML = chat?.questions.map((question) => renderQuestion(question, chat.partial)).join('') || (
      chat ? '<p class="muted">发一条问题，让 Codex 接着群聊背景分析。</p>' : ''
    );
    if (nearBottom || switched) log.scrollTop = log.scrollHeight;
  }

  function renderQuestion(question, partial) {
    const { id, authorId, authorName, text, status, answer, error, sharedMessageId } = question;
    const canCancel = ['queued', 'running'].includes(status) && (state.me.role === 'host' || state.me.id === authorId);
    let output;
    if (status === 'completed') {
      output = `<div class="side-answer">
        <strong>Codex</strong>
        <div class="message-content">${rich(answer)}</div>
        ${sharedMessageId ? '<span class="side-status">已带回主群</span>' :
          `<button type="button" class="side-link" data-share-side="${esc(id)}">带回主群</button>`}
      </div>`;
    } else {
      output = `<div class="side-status" role="status">${labels[status] || ''}${error ? ` · ${esc(error)}` : ''}</div>
        ${status === 'running' && partial ? `<div class="side-answer message-content">${rich(partial)}</div>` : ''}
        ${canCancel ? `<button type="button" class="side-link" data-cancel-side="${esc(id)}">停止侧聊回答</button>` : ''}`;
    }
    return `<article class="side-exchange">
      <strong>${esc(authorName)}</strong>
      <div class="message-content">${rich(text)}</div>
      ${output}
    </article>`;
  }

  toggle.onclick = () => {
    if (panel.hidden) {
      open(chatId);
      $('#close-side-chat').focus();
    } else close();
  };
  $('#close-side-chat').onclick = () => { close(); toggle.focus(); };
  $('#side-back').onclick = () => { open(null); $('#new-side-chat').focus(); };
  $('#new-side-chat').onclick = () => start();
  titleInput.oninput = () => { creation = null; };
  $('#side-new-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter;
    if (button.disabled) return;
    button.disabled = true;
    creation ||= newMessageId();
    try {
      const result = await api('/api/side-chats', { title: titleInput.value, anchorId, clientId: creation });
      dialog.close();
      open(result.id, true);
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  };
  input.oninput = () => {
    drafts.set(chatId, { text: input.value });
    render();
  };
  $('#side-form').onsubmit = async (event) => {
    event.preventDefault();
    const target = chatId;
    const text = input.value.trim();
    if (!target || !text || sending) return;
    const draft = drafts.get(target) || { text: input.value };
    draft.clientId ||= newMessageId();
    drafts.set(target, draft);
    sending = true;
    render();
    try {
      await api(`/api/side-chats/${target}/messages`, { text, clientId: draft.clientId });
      if (drafts.get(target) === draft) {
        drafts.delete(target);
        if (chatId === target) input.value = '';
      }
    } catch (error) { toast(error.message); }
    finally { sending = false; render(); }
  };
  panel.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const { openSide, shareSide, cancelSide } = button.dataset;
    if (openSide) {
      open(openSide, true);
    }
    if (!shareSide && !cancelSide) return;
    button.disabled = true;
    try {
      await api(`/api/side-chats/${chatId}/${shareSide ? 'share' : 'cancel'}`, { questionId: shareSide || cancelSide });
      if (shareSide) toast('已带回主群');
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  return { open, close, start, update(nextState) { state = nextState; render(); } };
}
