import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './validation.mjs';

const PREVIEWS = new Map([['.html', 'html'], ['.htm', 'html'], ['.md', 'markdown'], ['.markdown', 'markdown']]);
const IMAGES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif']]);
const FORMATS = new Set([...PREVIEWS.keys(), ...IMAGES.keys(), '.txt', '.csv', '.pdf', '.docx', '.xlsx', '.pptx']);
const MAX_BYTES = 32 * 1024 * 1024;
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

function localPath(target) {
  target = target.replace(/^<|>$/g, '').trim();
  try {
    if (target.startsWith('file://')) return fileURLToPath(target);
    return decodeURIComponent(target.replace(/#.*/, '')).replace(/:\d+(?::\d+)?$/, '');
  } catch { return null; }
}

function shareable(root, path, formats = FORMATS) {
  const name = relative(root, path);
  return Boolean(name) && !isAbsolute(name) && !name.split(sep).some((part) => part.startsWith('.') || part.toLowerCase() === 'node_modules')
    && formats.has(extname(name).toLowerCase());
}

export async function indexSourceFiles(room) {
  const root = await realpath(room.cwd).catch(() => null);
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const realCodexHome = await realpath(codexHome).catch(() => null);
  const threadIds = [...new Set([room.state.threadId, room.state.sourceThreadId])].filter((id) =>
    typeof id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id));
  const generatedImage = (home, path) => home && threadIds.some((id) =>
    shareable(join(home, 'generated_images', id), path, IMAGES));
  const allowedResolvedPath = (path) => shareable(root, path) || generatedImage(realCodexHome, path);
  const byMessage = new Map();
  const assetIds = new Map();
  const files = Object.create(null);
  let scanned = 0;
  let pending = Promise.resolve();

  async function addMessage(message) {
    const prose = message.text.split('```').filter((_, index) => index % 2 === 0)
      .join('\n').replace(/`[^`\n]+`/g, '');
    const links = Array.from(prose.matchAll(/!?\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/g), ([, label, target]) => ({ label, target }));
    for (const [, target] of prose.matchAll(/:codex-file-citation\{[^}\n]*\bpath="([^"\n]+)"[^}\n]*\}/g)) {
      links.push({ label: '', target });
    }
    const entries = [];
    const items = [];
    const visited = new Set();
    for (const { label, target } of links) {
      const local = localPath(target);
      if (!local || (!isAbsolute(local) && /^[\w+.-]+:/.test(local))) continue;
      const path = resolve(room.cwd, local);
      if (!shareable(room.cwd, path) && !generatedImage(codexHome, path) && !allowedResolvedPath(path)) continue;
      try {
        const resolved = await realpath(path);
        if (!allowedResolvedPath(resolved) || visited.has(resolved)) continue;
        const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const stat = await file.stat().finally(() => file.close());
        if (!stat.isFile() || stat.size > MAX_BYTES) continue;
        visited.add(resolved);
        const name = basename(resolved);
        const extension = extname(name).toLowerCase();
        const kind = PREVIEWS.get(extension);
        const preview = kind === 'markdown' && stat.size > MAX_MARKDOWN_BYTES ? null : kind;
        if (!assetIds.has(resolved)) assetIds.set(resolved, assetIds.size);
        items.push({ index: entries.length, assetId: assetIds.get(resolved), label: label.trim() || name,
          name, preview, imageType: IMAGES.get(extension) });
        entries.push({ path, resolved });
      } catch { /* Links to unavailable files are omitted. */ }
    }
    if (!items.length) return;
    files[message.id] = items;
    byMessage.set(message.id, entries);
  }

  function refresh() {
    if (!root || scanned === room.state.messages.length) return pending;
    const messages = room.state.messages.slice(scanned);
    scanned += messages.length;
    pending = pending.then(async () => {
      for (const message of messages) {
        if (message.role === 'agent' && typeof message.text === 'string') await addMessage(message);
      }
    });
    return pending;
  }

  await refresh();
  return {
    files,
    refresh,
    async read(messageId, index) {
      const metadata = files[messageId]?.find((entry) => entry.index === index);
      if (!metadata) throw new HttpError(404, '找不到来源文件');
      const entry = byMessage.get(messageId)[index];
      try {
        const resolved = await realpath(entry.path);
        if (resolved !== entry.resolved || !allowedResolvedPath(resolved)) throw new Error('file location changed');
        const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('invalid source file');
          return { file, name: metadata.name, size: stat.size, imageType: metadata.imageType };
        } catch (error) {
          await file.close();
          throw error;
        }
      } catch { throw new HttpError(404, '来源文件已移动或无法读取'); }
    },
  };
}
