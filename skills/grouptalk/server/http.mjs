import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { HttpError } from './room.mjs';
import { clientAddress, lookupClientMac } from './neighbors.mjs';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const FILES = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
FILES.set('/side-chat.js', ['side-chat.js', 'text/javascript']);
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function isHostConnection(req, url) {
  const loopback = (address) => address === '::1' || /^(::ffff:)?127\./.test(address || '');
  return loopback(req.socket.remoteAddress) && loopback(req.socket.localAddress)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
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

export function invitationLinks({ port, host, invite, interfaces = networkInterfaces() }) {
  const links = [];
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    for (const [name, entries] of Object.entries(interfaces)) for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) links.push({ label: `${name} · ${entry.address}`, url: `http://${entry.address}:${port}/#invite=${invite}`, physical: /^(en\d|eth\d|wlan\d|Wi-Fi)/i.test(name) });
    }
    links.sort((a, b) => Number(b.physical) - Number(a.physical));
  }
  links.push({ label: '仅本机 · 127.0.0.1', url: `http://127.0.0.1:${port}/#invite=${invite}`, localOnly: true });
  return links;
}

export async function serve({ room, host = '0.0.0.0', port = 4317, lookupMac = lookupClientMac }) {
  const streams = new Set();
  let flushTimer;
  const flush = () => {
    flushTimer = null;
    for (const stream of streams) {
      if (stream.res.writableLength > 2_000_000) { stream.res.destroy(); continue; }
      stream.res.write(`event: state\ndata: ${JSON.stringify(room.snapshot(stream.member))}\n\n`);
    }
  };
  const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(flush, 35); };
  const observe = (req, memberId) => {
    void room.observeNetwork(memberId, clientAddress(req.socket.remoteAddress), lookupMac).catch(() => {});
  };
  room.on('change', scheduleFlush);
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && FILES.has(url.pathname)) {
        const [file, type] = FILES.get(url.pathname);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
        res.end(await readFile(`${WEB}${file}`)); return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, runtime: room.runtime.state });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, '请求来源不正确');
      }
      if (url.pathname === '/api/join' && req.method === 'POST') {
        const joined = room.join(await body(req), { local: isHostConnection(req, url) });
        observe(req, joined.member.id);
        return json(res, 201, joined);
      }
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : url.pathname === '/api/events' ? url.searchParams.get('session') : '';
      const member = room.authenticate(token);
      if (member.role === 'host' && !isHostConnection(req, url)) throw new HttpError(403, '房主入口仅可在开房电脑上使用');
      if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
        observe(req, member.id);
        return json(res, 200, room.snapshot(member));
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        observe(req, member.id);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const stream = { member, res }; streams.add(stream);
        const disconnect = room.connect(member);
        res.write(`event: state\ndata: ${JSON.stringify(room.snapshot(member))}\n\n`);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => { clearInterval(heartbeat); streams.delete(stream); disconnect(); });
        return;
      }
      if (url.pathname === '/api/invite' && req.method === 'GET') {
        if (member.role !== 'host') throw new HttpError(403, '仅房主可以查看邀请');
        return json(res, 200, { invite: room.state.invite, links: invitationLinks({ port: server.address().port, host, invite: room.state.invite }) });
      }
      if (req.method === 'POST') {
        const input = await body(req);
        if (url.pathname === '/api/messages') return json(res, 201, room.post(member, input));
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
        const approvalRoute = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
        if (approvalRoute) { room.decideApproval(member, approvalRoute[1], input.decision); return json(res, 200, { ok: true }); }
        if (url.pathname === '/api/notes') return json(res, 201, room.addNote(member, input));
        if (/^\/api\/notes\/[^/]+$/.test(url.pathname)) { room.updateNote(member, url.pathname.split('/').at(-1), input); return json(res, 200, { ok: true }); }
        if (/^\/api\/tasks\/[^/]+\/cancel$/.test(url.pathname)) { await room.cancel(member, url.pathname.split('/')[3]); return json(res, 200, { ok: true }); }
        if (url.pathname === '/api/recover') { room.recover(member); return json(res, 200, { ok: true }); }
        if (url.pathname === '/api/invite/rotate') {
          const invite = room.rotateInvite(member);
          return json(res, 200, { invite, links: invitationLinks({ port: server.address().port, host, invite }) });
        }
      }
      json(res, 404, { error: '接口不存在' });
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    server, port: server.address().port,
    async close() {
      room.off('change', scheduleFlush); clearTimeout(flushTimer);
      for (const stream of streams) stream.res.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
