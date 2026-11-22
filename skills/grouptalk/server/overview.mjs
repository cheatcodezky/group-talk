import { marked } from './vendor/marked.mjs';
import { DEFAULT_ROOM_TOPIC } from './store.mjs';

const replyDetails = new WeakMap();

function plain(value) {
  return String(value ?? '')
    .replace(/!\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g, '')
    .replace(/\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/g, '$1')
    .replace(/:codex-file-citation\{[^}\n]*\}/g, '')
    .replace(/(?:https?:\/\/|file:\/\/|[\w]:[\\/])[^\s)\]，。]+/gi, '')
    .replace(/<[^>\n]+>/g, '')
    .replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

function shorten(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function describeReply(message) {
  const saved = replyDetails.get(message);
  if (saved?.text === message.text) return saved.details;
  const details = {};
  let section = '';
  for (const token of marked.lexer(message.text)) {
    if (token.type === 'heading') {
      section = plain(token.text);
      if (token.depth === 1 && !details.title) details.title = section;
    } else if (token.type === 'paragraph') {
      const text = plain(token.text);
      if (text.length < 12) continue;
      details.intro ??= text;
      if (/^(?:(?:评审|讨论|项目|本次|本轮)目标|目标|本次范围)/.test(text)) details.goal ??= text;
      if (/^(?:当前|已完成|已经|本次已)/.test(text) || /当前进展|已经验证|已完成|实测结果/.test(section)) details.update ??= text;
      if (/^(?:下一步|待确认|待定|建议推进)/.test(text) || /待定|下一步|待确认/.test(section)) details.next ??= text;
    } else if (token.type === 'table' && token.rows.length) {
      const heading = token.header.map(({ text }) => plain(text)).join(' ');
      if (/已验证|验证了|实测|结果/.test(section) && /结果|数值/.test(heading)) {
        details.results ??= token.rows.slice(0, 2).map(([name, value]) =>
          [plain(name?.text), plain(value?.text)].filter(Boolean).join(' ')).join(' · ');
      }
      if (/待定|待确认/.test(heading) || /要定下|待定|待确认/.test(section)) {
        details.next ??= token.rows.slice(0, 3).map(([name]) => plain(name?.text)).filter(Boolean).join('、');
      }
    }
  }
  replyDetails.set(message, { text: message.text, details });
  return details;
}

export function roomOverview(state, sourceFiles) {
  const messages = state.messages.filter((message) => ['user', 'agent'].includes(message.role));
  const replies = messages.filter(({ role }) => role === 'agent').slice(-16).reverse()
    .map((message) => ({ message, ...describeReply(message) }));
  const recap = replies.find(({ title, goal, update, results, next }) => title && goal && (update || results || next)) ||
    replies.find(({ message, intro }) => intro && sourceFiles[message.id]?.length) ||
    replies.find(({ intro }) => intro);
  const newerReplies = recap ? replies.slice(0, replies.indexOf(recap)) : [];
  const initialRequest = messages.find(({ role, text }) => role === 'user' && plain(text).length >= 20);
  const goal = state.topic && state.topic !== DEFAULT_ROOM_TOPIC ? plain(state.topic) :
    (recap?.goal || (recap?.title ? recap.intro : null) || plain(initialRequest?.text));
  const decision = state.decisions.findLast(({ kind }) => kind === 'decision');
  const openNote = state.decisions.findLast(({ kind, done }) => !done && (kind === 'action' || kind === 'question'));
  const points = [
    ['共同结论', plain(decision?.text)],
    ['当前进展', newerReplies.find(({ update }) => update)?.update || recap?.update || (recap?.intro !== goal && recap?.intro)],
    ['实测结果', newerReplies.find(({ results }) => results)?.results || recap?.results],
    [openNote?.kind === 'action' ? '下一步' : '待确认', plain(openNote?.text) || newerReplies.find(({ next }) => next)?.next || recap?.next],
  ].filter(([, text]) => text).map(([label, text]) => ({ label, text: shorten(text, 96) }));

  const seen = new Set();
  const files = [];
  for (const message of messages.toReversed()) {
    for (const file of sourceFiles[message.id] || []) {
      const key = file.assetId ?? `${message.id}:${file.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ ...file, messageId: message.id });
    }
  }
  const currentTask = state.tasks.findLast(({ status }) => status === 'running' || status === 'starting') ||
    state.tasks.find(({ status }) => status === 'awaiting_approval' || status === 'queued');
  return {
    title: shorten(recap?.title || '', 66), goal: shorten(goal || '', 116), points, files, coreItems: state.coreItems || [],
    messageId: recap?.message.id,
    task: currentTask && { status: currentTask.status, request: shorten(plain(currentTask.request), 76) },
  };
}
