import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './room.mjs';
import { clientAddress, lookupClientMac } from './neighbors.mjs';
import { indexSourceFiles, MAX_MARKDOWN_BYTES } from './source-files.mjs';
import { createPreviewAccess, previewPolicy, renderMarkdown } from './preview.mjs';
import { roomOverview } from './overview.mjs';
import { createReviews } from './reviews.mjs';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const FILES = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
FILES.set('/side-chat.js', ['side-chat.js', 'text/javascript']);
FILES.set('/rich-text.js', ['rich-text.js', 'text/javascript']);
FILES.set('/server/vendor/marked.mjs', ['../server/vendor/marked.mjs', 'text/javascript']);
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function isHostConnection(req, url) {
  const loopback = (address) => address === '::1' || /^(::ffff:)?127\./.test(address || '');
  return loopback(req.socket.remoteAddress) && loopback(req.socket.localAddress)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}
function memberAddress(req) {
  const ip = clientAddress(req.socket.remoteAddress);
  return ip === '::1' ? '127.0.0.1' : ip;
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请使用 JSON 请求');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32_000) throw new HttpError(413, '请求内容过大'); chunks.push(chunk); }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'JSON 格式不正确'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, '请求须为 JSON 对象');
  return parsed;
}

export function invitationLinks({ port, host, invite, protocol = 'http', interfaces = networkInterfaces() }) {
  const links = [];
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    for (const [name, entries] of Object.entries(interfaces)) for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) links.push({ label: `${name} · ${entry.address}`, url: `${protocol}://${entry.address}:${port}/#invite=${invite}`, physical: /^(en\d|eth\d|wlan\d|Wi-Fi)/i.test(name) });
    }
    links.sort((a, b) => Number(b.physical) - Number(a.physical));
  }
  links.push({ label: '仅本机 · 127.0.0.1', url: `${protocol}://127.0.0.1:${port}/#invite=${invite}`, localOnly: true });
  return links;
}

export async function serve({ room, host = '0.0.0.0', port = 4317, lookupMac = lookupClientMac, onStop, tls }) {
  const source = await indexSourceFiles(room);
  const previewAccess = createPreviewAccess();
  const reviews = createReviews(room);
  const protocol = tls ? 'https' : 'http';
  const inviteLinks = (invite) => invitationLinks({ port: server.address().port, host, invite, protocol });
  const snapshot = (member, overview = roomOverview(room.state, source.files)) => ({
    ...room.snapshot(member), sourceFiles: source.files, overview, canStop: Boolean(onStop) && member.role === 'host',
  });
  const streams = new Set();
  let stopRequested = false;
  let flushTimer;
  const flush = async () => {
    flushTimer = null;
    await source.refresh();
    const overview = roomOverview(room.state, source.files);
    for (const stream of streams) {
      if (stream.res.writableLength > 2_000_000) { stream.res.destroy(); continue; }
      stream.res.write(`event: state\ndata: ${JSON.stringify(snapshot(stream.member, overview))}\n\n`);
    }
  };
  const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flush, 35); };
  const observe = (req, memberId) => {
    void room.observeNetwork(memberId, memberAddress(req), lookupMac).catch(() => {});
  };
  room.on('change', scheduleFlush);
  const handleRequest = async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, `${protocol}://${req.headers.host || 'localhost'}`);
      if (stopRequested && !(url.pathname === '/api/stop' && req.method === 'POST')) throw new HttpError(503, '房间正在停止');
      if (req.method === 'GET' && FILES.has(url.pathname)) {
        const [file, type] = FILES.get(url.pathname);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
        res.end(await readFile(`${WEB}${file}`)); return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, runtime: room.runtime.state });
      const preview = url.pathname.match(/^\/source-preview\/([\da-f-]+)\/(\d+)$/);
      if (preview && req.method === 'GET') {
        if (!previewAccess.allows(url.pathname, url.searchParams.get('ticket'))) throw new HttpError(404, '预览链接无效或已过期');
        const [, message, index] = preview;
        const kind = source.files[message]?.find((item) => item.index === Number(index))?.preview;
        if (!kind) throw new HttpError(404, '此文件没有可用预览');
        const { file, name, size } = await source.read(message, Number(index));
        const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': previewPolicy(kind) };
        if (kind === 'markdown') {
          try {
            if (size > MAX_MARKDOWN_BYTES) throw new HttpError(413, 'Markdown 文件过大，请下载原件查看');
            const bytes = Buffer.alloc(size);
            const { bytesRead } = await file.read(bytes, 0, size, 0);
            const page = renderMarkdown(bytes.subarray(0, bytesRead).toString('utf-8'), name);
            res.writeHead(200, headers);
            return res.end(page);
          } finally { await file.close(); }
        }
        res.writeHead(200, { ...headers, 'content-length': size });
        if (!size) { await file.close(); return res.end(); }
        return await pipeline(file.createReadStream({ end: size - 1 }), res);
      }
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, '请求来源不正确');
      }
      if (url.pathname === '/api/join' && req.method === 'POST') {
        const input = await body(req);
        if (stopRequested) throw new HttpError(503, '房间正在停止');
        const joined = room.join(input, { local: isHostConnection(req, url), ip: memberAddress(req) });
        observe(req, joined.member.id);
        return json(res, 201, joined);
      }
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : url.pathname === '/api/events' ? url.searchParams.get('session') : '';
      if (url.pathname === '/api/review' && ['GET', 'POST'].includes(req.method)) {
        if (!req.socket.encrypted && !isHostConnection(req, url)) throw new HttpError(403, '局域网评审需要使用 HTTPS');
        const ip = memberAddress(req);
        if (req.method === 'GET') return json(res, 200, reviews.read(token, ip));
        const input = await body(req);
        if (stopRequested) throw new HttpError(503, '房间正在停止');
        const message = reviews.comment(token, ip, input);
        return json(res, 201, { id: message.id, authorName: message.authorName });
      }
      const member = room.authenticate(token, memberAddress(req));
      if (member.role === 'host' && !isHostConnection(req, url)) throw new HttpError(403, '房主入口仅可在开房电脑上使用');
      if (url.pathname === '/api/stop' && req.method === 'POST') {
        if (member.role !== 'host') throw new HttpError(403, '仅本机房主可以停止服务');
        if (!onStop) throw new HttpError(503, '当前服务不支持从网页停止');
        await body(req);
        if (!stopRequested) {
          stopRequested = true;
          const beginStop = () => {
            res.off('finish', beginStop);
            res.off('close', beginStop);
            void onStop();
          };
          if (res.destroyed) { beginStop(); return; }
          res.once('finish', beginStop);
          res.once('close', beginStop);
        }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
        observe(req, member.id);
        await source.refresh();
        return json(res, 200, snapshot(member));
      }
      const previewRequest = url.pathname.match(/^\/api\/source-files\/([\da-f-]+)\/(\d+)\/preview$/);
      if (previewRequest && req.method === 'GET') {
        const [, message, index] = previewRequest;
        const item = source.files[message]?.find((entry) => entry.index === Number(index));
        if (!item?.preview) throw new HttpError(404, '此文件没有可用预览');
        return json(res, 200, { url: previewAccess.url(`/source-preview/${message}/${index}`) });
      }
      const sourceFile = url.pathname.match(/^\/api\/source-files\/([\da-f-]+)\/(\d+)$/);
      if (sourceFile && req.method === 'GET') {
        const { file, size, name, imageType } = await source.read(sourceFile[1], Number(sourceFile[2]));
        res.writeHead(200, {
          'content-type': imageType || 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16))}`,
        });
        if (!size) { await file.close(); return res.end(); }
        return await pipeline(file.createReadStream({ end: size - 1 }), res);
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        observe(req, member.id);
        await source.refresh();
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const stream = { member, res }; streams.add(stream);
        const disconnect = room.connect(member);
        res.write(`event: state\ndata: ${JSON.stringify(snapshot(member))}\n\n`);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => { clearInterval(heartbeat); streams.delete(stream); disconnect(); });
        return;
      }
      if (url.pathname === '/api/invite' && req.method === 'GET') {
        if (member.role !== 'host') throw new HttpError(403, '仅房主可以查看邀请');
        return json(res, 200, { invite: room.state.invite, links: inviteLinks(room.state.invite) });
      }
      if (url.pathname === '/api/review-links' && req.method === 'GET') {
        if (member.role !== 'host') throw new HttpError(403, '仅本机房主可以管理评审链接');
        return json(res, 200, { active: reviews.list(), links: inviteLinks('').filter((link) => tls || link.localOnly) });
      }
      if (req.method === 'POST') {
        const input = await body(req);
        if (stopRequested) throw new HttpError(503, '房间正在停止');
        if (url.pathname === '/api/messages') return json(res, 201, room.post(member, input));
        if (url.pathname === '/api/git-inspection') return json(res, 201, await room.inspectGit(member, input));
        if (url.pathname === '/api/side-chats') return json(res, 201, { id: room.sideChats.create(member, input).id });
        const sideRoute = url.pathname.match(/^\/api\/side-chats\/([^/]+)\/(messages|share|cancel)$/);
        if (sideRoute) {
          const [, chatId, action] = sideRoute;
          if (action === 'messages') return json(res, 201, room.sideChats.post(member, chatId, input));
          if (action === 'share') return json(res, 200, room.sideChats.share(member, chatId, input.questionId));
          room.sideChats.cancel(member, chatId, input.questionId);
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/settings') { room.configure(member, input); return json(res, 200, { ok: true }); }
        const reviewRevoke = url.pathname.match(/^\/api\/review-links\/([\da-f-]+)\/revoke$/);
        if (url.pathname === '/api/review-links' || reviewRevoke) {
          if (member.role !== 'host') throw new HttpError(403, '仅本机房主可以管理评审链接');
          if (reviewRevoke) { reviews.revoke(reviewRevoke[1]); return json(res, 200, { ok: true }); }
          return json(res, 201, reviews.issue(input));
        }
        const memberRoute = url.pathname.match(/^\/api\/members\/([\da-f-]+)\/name$/);
        if (memberRoute) return json(res, 200, room.renameMember(member, memberRoute[1], input));
        const approvalRoute = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
        if (approvalRoute) { room.decideApproval(member, approvalRoute[1], input.decision); return json(res, 200, { ok: true }); }
        if (url.pathname === '/api/notes') return json(res, 201, room.addNote(member, input));
        if (/^\/api\/notes\/[^/]+$/.test(url.pathname)) { room.updateNote(member, url.pathname.split('/').at(-1), input); return json(res, 200, { ok: true }); }
        if (/^\/api\/tasks\/[^/]+\/cancel$/.test(url.pathname)) { await room.cancel(member, url.pathname.split('/')[3]); return json(res, 200, { ok: true }); }
        if (url.pathname === '/api/recover') { room.recover(member); return json(res, 200, { ok: true }); }
        if (url.pathname === '/api/invite/rotate') {
          const invite = room.rotateInvite(member);
          return json(res, 200, { invite, links: inviteLinks(invite) });
        }
      }
      json(res, 404, { error: '接口不存在' });
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.message }); else res.end(); }
  };
  const server = tls ? https.createServer(tls, handleRequest) : http.createServer(handleRequest);
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    server, port: server.address().port,
    async close({ notifyStop = false } = {}) {
      stopRequested = true;
      room.off('change', scheduleFlush); clearTimeout(flushTimer);
      for (const { res } of streams) res.end(notifyStop ? 'event: shutdown\ndata: {}\n\n' : undefined);
      const closed = new Promise((resolve) => server.close(resolve));
      const drain = setTimeout(() => server.closeAllConnections(), 1500);
      try { await closed; } finally { clearTimeout(drain); }
    },
  };
}
