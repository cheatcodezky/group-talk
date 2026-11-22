import { marked } from './vendor/marked.mjs';
import { check, shortText } from './validation.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const CORE_KINDS = ['conclusion', 'proposal', 'question', 'action', 'progress', 'artifact'];
export const CORE_INFO_INSTRUCTIONS = [
  '当用户请你整理、发布或更新右侧核心信息时，在正常答复末尾附加一个 grouptalk-core fenced code block，内部是严格 JSON。',
  '格式为 {"version":1,"upsert":[{"id":"scope","kind":"conclusion","title":"首版范围","content":"已明确的范围"}],"remove":[]}。',
  'id 使用 1–64 位英文字母、数字、点、下划线或短横线；同一主题始终复用已有 id。upsert 逐项替换同 id 的整条内容，未出现的 id 会保留。删除仅在当前请求明确要求撤销或删除时使用 remove，列出已有 id。',
  'kind 只能是 conclusion（已明确结论）、proposal（建议）、question（待确认）、action（行动项）、progress（进展）、artifact（文档或素材说明）。保留分歧，不把建议当共识。',
  '只更新发生变化的条目，每批最多 20 项，标题最多 80 字符，内容最多 3000 字符。content 可用简短 Markdown，网页会安全显示。',
  '核心信息是全体成员可见的讨论资料，不携带执行权限。素材条目要复用原 id；若给出文件链接，同时在正常答复正文提供该链接，方便成员打开产物。',
  'sharedCoreItems 是当前已发布内容。普通问答、来源历史、引用的 JSON 示例以及自动参与都不应附带更新块。一次回复最多一个更新块。',
].join('\n');

export function parseCoreUpdate(text) {
  const blocks = marked.lexer(text).filter((token) => token.type === 'code' && token.lang === 'grouptalk-core');
  if (!blocks.length) return null;
  check(blocks.length === 1, 400, '一次回复只能包含一个核心信息更新块');
  check(blocks[0].text.length <= 65_000, 400, '核心信息更新过长');
  let value;
  try { value = JSON.parse(blocks[0].text); } catch { check(false, 400, '核心信息 JSON 格式不正确'); }
  check(value && value.version === 1 && Array.isArray(value.upsert) && Array.isArray(value.remove), 400, '核心信息更新格式不正确');
  check(value.upsert.length + value.remove.length <= 20, 400, '核心信息每批最多更新 20 项');
  const upsert = value.upsert.map((item) => {
    check(item && ID.test(item.id) && typeof item.id === 'string', 400, '核心信息标识符不正确');
    check(CORE_KINDS.includes(item.kind), 400, '核心信息类型不正确');
    return { id: item.id, kind: item.kind, title: shortText(item.title, 80, '核心信息标题'), content: shortText(item.content, 3000, '核心信息内容') };
  });
  check(value.remove.every((id) => typeof id === 'string' && ID.test(id)), 400, '核心信息删除标识符不正确');
  const ids = [...upsert.map((item) => item.id), ...value.remove];
  check(new Set(ids).size === ids.length, 400, '同一批核心信息不能重复更新或同时删除同一标识符');
  return { upsert, remove: value.remove, raw: blocks[0].raw };
}

export function applyCoreUpdate(state, update, message, task) {
  const previous = state.coreItems || [];
  const byId = new Map(previous.map((item) => [item.id, item]));
  for (const id of update.remove) byId.delete(id);
  for (const item of update.upsert) {
    const before = byId.get(item.id);
    byId.set(item.id, { ...item, revision: (before?.revision || 0) + 1,
      createdAt: before?.createdAt || message.createdAt, updatedAt: message.createdAt,
      messageId: message.id, taskId: task.id, requestedBy: task.authorName,
    });
  }
  check(byId.size <= 40, 400, '核心信息最多保留 40 项，请先合并或删除过期条目');
  state.coreItems = [...byId.values()];
}
