import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './validation.mjs';

const FORMATS = new Set(['.md', '.txt', '.csv', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.docx', '.xlsx', '.pptx']);
const MAX_BYTES = 32 * 1024 * 1024;

function localPath(target) {
  target = target.replace(/^<|>$/g, '').trim();
  try {
    if (target.startsWith('file://')) return fileURLToPath(target);
    return decodeURIComponent(target.replace(/#.*/, '')).replace(/:\d+(?::\d+)?$/, '');
  } catch { return null; }
}

function shareable(root, path) {
  const name = relative(root, path);
  return Boolean(name) && !isAbsolute(name) && !name.split(sep).some((part) => part.startsWith('.') || part.toLowerCase() === 'node_modules')
    && FORMATS.has(extname(name).toLowerCase());
}

export async function indexSourceFiles(room) {
  const root = await realpath(room.cwd).catch(() => null);
  const byMessage = new Map();
  for (const message of room.state.messages) {
    if (!root || !message.history || message.role !== 'agent') continue;
    const links = message.text.split('```').filter((_, index) => index % 2 === 0)
      .flatMap((text) => Array.from(text.replace(/`[^`\n]+`/g, '').matchAll(/!?\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/g)));
    const files = new Map();
    for (const [, label, target] of links) {
      const path = localPath(target);
      if (path && isAbsolute(path) && (shareable(room.cwd, path) || shareable(root, path))) {
        files.set(path, { path, label: label.trim() || basename(path) });
      }
    }
    if (files.size) byMessage.set(message.id, [...files.values()]);
  }
  if (!byMessage.size) return { files: {}, read: async () => { throw new HttpError(404, '找不到来源文件'); } };
  const files = {};
  for (const [messageId, entries] of byMessage) {
    for (const [index, entry] of entries.entries()) {
      try {
        entry.resolved = await realpath(entry.path);
        if (!shareable(root, entry.resolved)) continue;
        const file = await open(entry.resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const stat = await file.stat().finally(() => file.close());
        if (!stat.isFile() || stat.size > MAX_BYTES) continue;
        const items = files[messageId] ||= [];
        items.push({ index, label: entry.label, name: basename(entry.resolved) });
      } catch { /* Paths removed or inaccessible during import are omitted. */ }
    }
  }
  return {
    files,
    async read(messageId, index) {
      const metadata = files[messageId]?.find((entry) => entry.index === index);
      if (!metadata) throw new HttpError(404, '找不到来源文件');
      const entry = byMessage.get(messageId)[index];
      try {
        const resolved = await realpath(entry.path);
        if (resolved !== entry.resolved || !shareable(root, resolved)) throw new Error('file location changed');
        const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('invalid source file');
          return { file, name: metadata.name, size: stat.size };
        } catch (error) {
          await file.close();
          throw error;
        }
      } catch { throw new HttpError(404, '来源文件已移动或无法读取'); }
    },
  };
}
