import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, invitationLinks } from '../skills/grouptalk/server/http.mjs';
import { FakeAgent, fixture, message, until } from './helpers.mjs';
import { networkInterfaces } from 'node:os';
import { request } from 'node:http';
import { clientAddress, macFromNeighbors } from '../skills/grouptalk/server/neighbors.mjs';
import { mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HTTP 与两个实时客户端共享同一房间，重连可以恢复消息与任务', async (t) => {
  const f = await fixture();
  const web = await serve({ room: f.room, host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${web.port}`;
  const controllers = [];
  t.after(async () => { controllers.forEach((c) => c.abort()); f.room.close(); await web.close(); f.store.close(); });
  const request = async (path, token, data) => {
    const response = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    return { response, data: await response.json() };
  };
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base + '/api/bootstrap')).status, 401);
  const collect = async (token) => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${base}/api/events?session=${token}`, { signal: controller.signal });
    const snapshots = [];
    void (async () => {
      let buffer = '';
      try {
        for await (const chunk of response.body) {
          buffer += Buffer.from(chunk).toString();
          const blocks = buffer.split('\n\n'); buffer = blocks.pop();
          for (const block of blocks) if (block.startsWith('event: state')) snapshots.push(JSON.parse(block.split('data: ')[1]));
        }
      } catch (error) { if (error.name !== 'AbortError') throw error; }
    })();
    return snapshots;
  };
  const alice = await collect(f.tokens.alice); const bob = await collect(f.tokens.bob);
  await until(() => alice.length && bob.length);
  await Promise.all([
    request('/api/messages', f.tokens.alice, message('王：希望缓存十分钟')),
    request('/api/messages', f.tokens.bob, message('李：必须隔离租户')),
  ]);
  await until(() => alice.at(-1).messages.length === 2 && bob.at(-1).messages.length === 2);
  assert.deepEqual(alice.at(-1).messages.map((m) => m.seq), bob.at(-1).messages.map((m) => m.seq));
  const result = await request('/api/messages', f.tokens.alice, message('请一起判断方案', 'ask'));
  await until(() => bob.at(-1).tasks.some((task) => task.id === result.data.task.id && task.status === 'completed'));
  assert.equal(alice.at(-1).threadId, bob.at(-1).threadId);
  assert.equal(bob.at(-1).messages.at(-1).role, 'agent');
  const reconnected = await collect(f.tokens.alice);
  await until(() => reconnected.length > 0);
  assert.equal(reconnected[0].messages.length, 4);
  const privateData = JSON.stringify(reconnected[0]);
  assert.equal(privateData.includes(f.store.state.hostKey), false);
  assert.equal(privateData.includes(f.store.state.invite), false);
  assert.equal((await request('/api/settings', f.tokens.bob, { allowExecution: true })).response.status, 403);
  assert.equal((await request('/api/messages', f.tokens.bob, message('非法执行', 'execute'))).response.status, 403);
  const badOrigin = await fetch(base + '/api/messages', { method: 'POST', headers: { authorization: `Bearer ${f.tokens.bob}`, 'content-type': 'application/json', origin: 'http://foreign.example' }, body: JSON.stringify(message('跨站')) });
  assert.equal(badOrigin.status, 403);
});

test('成员和局域网来访者无法使用房主审批，房主本机可以单次拒绝或批准', async (t) => {
  const f = await fixture();
  const web = await serve({ room: f.room, host: '0.0.0.0', port: 0 });
  t.after(async () => { f.room.close(); await web.close(); f.store.close(); });
  const base = `http://127.0.0.1:${web.port}`;
  const post = (path, data, token, options = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = request((options.base || base) + path, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers,
    } }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject);
    req.end(body);
  });
  f.room.configure(f.owner, { allowExecution: true });
  const task = f.room.post(f.alice, message('创建一个报告文件', 'execute')).task;
  const endpoint = `/api/approvals/${task.id}`;
  assert.equal((await post(endpoint, { decision: 'accept' }, f.tokens.alice)).status, 403);
  assert.equal((await post(endpoint, { decision: 'accept' }, f.tokens.owner, { headers: { host: `lan.example:${web.port}`, 'x-forwarded-for': '127.0.0.1' } })).status, 403);
  assert.equal(f.agent.calls.length, 0);
  const lan = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal);
  if (lan) {
    const options = { base: `http://${lan.address}:${web.port}`, headers: { host: `127.0.0.1:${web.port}`, 'x-forwarded-for': '127.0.0.1' } };
    assert.equal((await post('/api/join', { key: f.store.state.hostKey, name: '远程房主' }, null, options)).status, 403);
    assert.equal((await post(endpoint, { decision: 'accept' }, f.tokens.owner, options)).status, 403);
    assert.equal((await post('/api/join', { key: f.store.state.invite, name: '局域网成员' }, null, options)).status, 201);
  }
  let decision;
  f.room.requestApproval(task, { kind: '命令执行', detail: 'private approval details' }, (value) => { decision = value; });
  const owner = f.room.snapshot(f.owner);
  const member = f.room.snapshot(f.alice);
  assert.equal(member.pendingApprovalCount, 2);
  assert.doesNotMatch(JSON.stringify(member), /private approval details/);
  const pending = owner.approvals.find((entry) => entry.kind === '命令执行');
  assert.equal((await post(`/api/approvals/${pending.id}`, { decision: 'decline' }, f.tokens.owner)).status, 200);
  assert.equal(decision, 'decline');
  assert.equal((await post(`/api/approvals/${pending.id}`, { decision: 'accept' }, f.tokens.owner)).status, 409);
  assert.equal((await post(endpoint, { decision: 'accept' }, f.tokens.owner)).status, 200);
  await until(() => task.status === 'completed');
});

test('邀请链接使用真实局域网地址，实体网卡优先且本机入口明确区分', () => {
  const interfaces = {
    utun4: [{ family: 'IPv4', address: '192.168.255.254', internal: false }],
    en0: [{ family: 'IPv4', address: '192.168.1.28', internal: false }],
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  };
  const links = invitationLinks({ port: 4317, host: '0.0.0.0', invite: 'test', interfaces });
  assert.equal(links[0].url, 'http://192.168.1.28:4317/#invite=test');
  assert.equal(links.at(-1).localOnly, true);
  const localOnly = invitationLinks({ port: 4317, host: '127.0.0.1', invite: 'test', interfaces });
  assert.equal(localOnly.length, 1); assert.equal(localOnly[0].localOnly, true);
});

test('只有本机房主能停止服务，收到成功响应后向成员发送停止事件', async (t) => {
  const f = await fixture();
  let stops = 0;
  let closed;
  const web = await serve({ room: f.room, host: '0.0.0.0', port: 0, onStop: () => {
    stops++;
    closed = web.close({ notifyStop: true });
  } });
  t.after(async () => { f.room.close(); await (closed || web.close()); f.store.close(); });
  const base = `http://127.0.0.1:${web.port}`;
  const stop = (token, url = base) => fetch(url + '/api/stop', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{}',
  });
  const bootstrap = (token) => fetch(base + '/api/bootstrap', { headers: { authorization: `Bearer ${token}` } }).then((result) => result.json());
  assert.equal((await bootstrap(f.tokens.owner)).canStop, true);
  assert.equal((await bootstrap(f.tokens.alice)).canStop, false);
  assert.equal((await stop()).status, 401);
  assert.equal((await stop(f.tokens.alice)).status, 403);
  const lan = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal);
  if (lan) assert.equal((await stop(f.tokens.owner, `http://${lan.address}:${web.port}`)).status, 403);
  assert.equal(stops, 0);

  const events = await fetch(base + '/api/events?session=' + f.tokens.alice, { signal: AbortSignal.timeout(5000) });
  const stream = events.text();
  const result = await stop(f.tokens.owner);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true });
  assert.match(await stream, /event: shutdown\ndata: \{\}/);
  assert.equal(stops, 1);
  await closed;
  await assert.rejects(fetch(base + '/api/health'));
});

test('同一 IP 沿用成员及房主备注，凭证角色独立，连接地址只给房主', async (t) => {
  const f = await fixture();
  const mac = '02:11:22:33:44:55';
  const web = await serve({ room: f.room, host: '127.0.0.1', port: 0, lookupMac: async () => mac });
  t.after(async () => { f.room.close(); await web.close(); f.store.close(); });
  f.store.state.members.find(({ id }) => id === f.owner.id).name = '测试主持人';
  const base = `http://127.0.0.1:${web.port}`;
  const join = async (key, name) => {
    const response = await fetch(base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.8' }, body: JSON.stringify({ key, name, ip: '203.0.113.8' }) });
    assert.equal(response.status, 201);
    return response.json();
  };
  const owner = await join(f.store.state.hostKey, '');
  const secondOwner = await join(f.store.state.hostKey);
  const member = await join(f.store.state.invite, '这次换名');
  assert.equal(owner.member.name, '房主');
  assert.equal(owner.member.role, 'host');
  assert.equal(secondOwner.member.name, '房主');
  assert.equal(member.member.id, owner.member.id);
  assert.equal(secondOwner.member.id, owner.member.id);
  assert.equal(member.member.role, 'member');
  assert.ok(!('network' in member.member));
  const snapshot = async (token) => (await fetch(base + '/api/bootstrap', { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual((await snapshot(owner.token)).members.find(({ id }) => id === member.member.id).network, { ip: '127.0.0.1', mac });
  assert.ok((await snapshot(member.token)).members.every((entry) => !('network' in entry)));
  const rename = (token, name) => fetch(`${base}/api/members/${member.member.id}/name`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  assert.equal((await rename(member.token, '未经批准的备注')).status, 403);
  assert.equal((await rename(owner.token, '评审负责人')).status, 200);
  assert.equal((await snapshot(member.token)).me.name, '评审负责人');
  assert.deepEqual((await join(f.store.state.invite)).member.name, '评审负责人');
  assert.throws(() => f.room.authenticate(member.token, '192.0.2.10'), /连接地址已变化/);
  const elsewhere = f.room.join({ key: f.store.state.invite }, { ip: '192.0.2.10' });
  assert.notEqual(elsewhere.member.id, member.member.id);
  assert.match(elsewhere.member.name, /^[\p{Script=Han}]+ \d{4}$/u);
  assert.ok(f.store.state.members.every((entry) => !('network' in entry)));
});

test('评审链接仅返回批准材料，发言沿用连接 IP 且无法触发 Codex 或取得房间权限', async (t) => {
  const f = await fixture();
  f.store.addMessage({ role: 'user', authorId: 'private', authorName: '未分享来源', text: '未批准的内部记录', history: true });
  const web = await serve({ room: f.room, host: '0.0.0.0', port: 0 });
  t.after(async () => { f.room.close(); await web.close(); f.store.close(); });
  const base = `http://127.0.0.1:${web.port}`;
  const call = (path, token, data, origin = base) => fetch(origin + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const joined = await fetch(base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: f.store.state.invite, name: '评审者' }) }).then((result) => result.json());
  const issue = { context: '这是房主批准的技术方案 v2' };
  assert.equal((await call('/api/review-links', joined.token, issue)).status, 403);
  const { id, token } = await (await call('/api/review-links', f.tokens.owner, issue)).json();
  const packet = await (await call('/api/review', token)).json();
  assert.equal(packet.context, issue.context);
  assert.doesNotMatch(JSON.stringify(packet), /未批准的内部记录|threadId|workspace/);
  assert.equal((await call('/api/bootstrap', token)).status, 401);
  assert.equal((await call('/api/review', joined.token)).status, 403);
  const lan = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal);
  if (lan) assert.equal((await call('/api/review', token, undefined, `http://${lan.address}:${web.port}`)).status, 403);
  const post = (requestId) => call('/api/review', token, { text: '@Codex 这是评审文本', requestId });
  const first = await (await post('first')).json();
  assert.deepEqual(await (await post('first')).json(), first);
  const written = f.store.state.messages.find((entry) => entry.id === first.id);
  assert.equal(written.authorId, joined.member.id);
  assert.equal(written.authorName, '评审者');
  assert.equal(f.store.state.tasks.length, 0);
  assert.equal((await post('second')).status, 201);
  assert.equal((await post('third')).status, 201);
  assert.equal((await post('fourth')).status, 429);
  assert.equal((await call(`/api/review-links/${id}/revoke`, f.tokens.owner, {})).status, 200);
  assert.equal((await call('/api/review', token)).status, 403);
  assert.equal((await post('first')).status, 403);
});

test('识别 IPv4 映射地址及各平台邻居记录，仅返回对应 IP 的单一 MAC', () => {
  const ip = '192.168.31.42';
  assert.equal(clientAddress(`::ffff:${ip}`), ip);
  assert.equal(clientAddress('::1'), '::1');
  assert.equal(clientAddress('example.com'), null);
  assert.equal(macFromNeighbors(`? (${ip}) at a:1b:2:33:44:5 on en0 ifscope [ethernet]`, ip), '0a:1b:02:33:44:05');
  assert.equal(macFromNeighbors(`  ${ip}   0A-1B-02-33-44-05   dynamic`, ip), '0a:1b:02:33:44:05');
  assert.equal(macFromNeighbors(`${ip} dev eth0 lladdr 0a:1b:02:33:44:05 REACHABLE`, ip), '0a:1b:02:33:44:05');
  assert.equal(macFromNeighbors(`${ip} dev eth0 INCOMPLETE\n192.168.31.43 dev eth0 lladdr 0a:1b:02:33:44:05 REACHABLE`, ip), null);
  assert.equal(macFromNeighbors(`${ip} dev eth0 lladdr 0a:1b:02:33:44:05 STALE\n${ip} dev eth1 lladdr 0a:1b:02:33:44:06 STALE`, ip), null);
});

test('房主与成员可预览和下载明确链接的工作区产出', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'grouptalk-source-files-'));
  const cwd = join(temp, 'project');
  mkdirSync(cwd);
  const report = join(cwd, '设计 文档.md');
  const page = join(cwd, '交互报告.html');
  const outside = join(temp, 'outside.md');
  const dotfile = join(cwd, '.private.md');
  const example = join(cwd, 'example.md');
  const alias = join(cwd, 'shortcut.md');
  for (const path of [outside, dotfile, example]) writeFileSync(path, '这是验收文件');
  const markdown = '# 采样结果\n\n| 指标 | 结果 |\n| -- | -- |\n| 采样率 | 100% |\n\n<script>无效的原始 HTML</script>';
  const html = '<!doctype html><title>采样</title><script>document.title = "交互采样";</script>';
  writeFileSync(report, markdown);
  writeFileSync(page, html);
  if (process.platform !== 'win32') symlinkSync(outside, alias);
  const history = [{ items: [
    { type: 'userMessage', content: [{ type: 'text', text: `[用户引用](<${example}>)` }] },
    { type: 'agentMessage', text: `已完成 [设计文档](<${report}:12>)。[交互报告](<${page}>)\n[房间外](<${outside}>)\n[隐藏](<${dotfile}>)\n[软链接](<${alias}>)\n` +
      '`[示例](<' + example + '>)`' },
  ] }];
  const f = await fixture({ cwd, sourceThreadId: 'test-source', agent: new FakeAgent({ history }) });
  const web = await serve({ room: f.room, host: '127.0.0.1', port: 0 });
  t.after(async () => { f.room.close(); await web.close(); f.store.close(); rmSync(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${web.port}`;
  const get = (path, token) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const owner = await (await get('/api/bootstrap', f.tokens.owner)).json();
  const member = await (await get('/api/bootstrap', f.tokens.alice)).json();
  assert.deepEqual(member.messages.map(({ role, history }) => ({ role, history })), [{ role: 'user', history: true }, { role: 'agent', history: true }]);
  assert.deepEqual(member.sourceFiles, owner.sourceFiles);
  const agentMessage = member.messages.find(({ role }) => role === 'agent');
  const [{ index, label, name, preview }, htmlFile] = member.sourceFiles[agentMessage.id];
  assert.equal(Object.values(member.sourceFiles).flat().length, 2);
  assert.equal(label, '设计文档');
  assert.equal(name, '设计 文档.md');
  assert.equal(preview, 'markdown');
  assert.equal(htmlFile.preview, 'html');
  const endpoint = `/api/source-files/${agentMessage.id}/${index}`;
  assert.equal((await get(endpoint)).status, 401);
  const download = await get(endpoint, f.tokens.alice);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await download.text(), markdown);
  assert.equal((await get(`/api/source-files/${agentMessage.id}/2`, f.tokens.alice)).status, 404);
  assert.equal((await get(`${endpoint}/preview`)).status, 401);
  const { url } = await (await get(`${endpoint}/preview`, f.tokens.alice)).json();
  const rendered = await get(url);
  assert.equal(rendered.status, 200);
  assert.match(rendered.headers.get('content-type'), /^text\/html/);
  assert.match(rendered.headers.get('content-security-policy'), /script-src 'none'/);
  const renderedMarkdown = await rendered.text();
  assert.match(renderedMarkdown, /<h1>采样结果<\/h1>/);
  assert.match(renderedMarkdown, /<table>/);
  assert.doesNotMatch(renderedMarkdown, /<script>/);
  const [address, ticket] = url.split('?');
  assert.equal((await get(address)).status, 404);
  assert.equal((await get(`${address.replace(/\/\d+$/, `/${htmlFile.index}`)}?${ticket}`)).status, 404);
  const { url: htmlUrl } = await (await get(`/api/source-files/${agentMessage.id}/${htmlFile.index}/preview`, f.tokens.alice)).json();
  const renderedHtml = await get(htmlUrl);
  assert.match(renderedHtml.headers.get('content-security-policy'), /sandbox allow-scripts;/);
  assert.equal(await renderedHtml.text(), html);
  renameSync(report, join(cwd, 'moved.md'));
  if (process.platform !== 'win32') symlinkSync(outside, report);
  assert.equal((await get(endpoint, f.tokens.alice)).status, 404);
});

test('房间运行中新回复链接的产物对成员可见', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'grouptalk-live-source-file-'));
  const report = join(cwd, 'report.md');
  const image = join(cwd, 'plot.PNG');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK9sAAAAASUVORK5CYII=', 'base64');
  writeFileSync(report, '# 房间产出');
  writeFileSync(image, png);
  const f = await fixture({ cwd });
  const web = await serve({ room: f.room, host: '127.0.0.1', port: 0 });
  t.after(async () => { f.room.close(); await web.close(); f.store.close(); rmSync(report); rmSync(image); rmdirSync(cwd); });
  const reply = f.store.addMessage({ role: 'agent', authorId: 'codex', authorName: 'Codex',
    text: `:codex-file-citation{path="${report}" purpose="output"}\n\n![内存曲线](plot.PNG)` });
  f.room.commit();
  const base = `http://127.0.0.1:${web.port}`;
  const member = { headers: { authorization: `Bearer ${f.tokens.bob}` } };
  const snapshot = await fetch(`${base}/api/bootstrap`, member);
  assert.equal(snapshot.status, 200);
  const { sourceFiles } = await snapshot.json();
  assert.deepEqual(sourceFiles[reply.id], [
    { index: 0, assetId: 0, label: '内存曲线', name: 'plot.PNG', imageType: 'image/png' },
    { index: 1, assetId: 1, label: 'report.md', name: 'report.md', preview: 'markdown' },
  ]);
  const source = `${base}/api/source-files/${reply.id}/0`;
  assert.equal((await fetch(source)).status, 401);
  const result = await fetch(source, member);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'image/png');
  assert.match(result.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), png);
});

test('新成员入场即可看到可核对的速览和去重后的产物入口', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'grouptalk-overview-'));
  const report = join(cwd, 'review.md');
  writeFileSync(report, '# 评审材料');
  const f = await fixture({ cwd });
  const recap = f.store.addMessage({ role: 'agent', authorId: 'codex', authorName: 'Codex', history: true, text: [
    '# 性能评审', '', '评审目标是比较两个版本在同一台机器上的内存开销。', '',
    '当前已完成采样脚本，可按场景输出重复采样结果。', '', '## 已验证', '',
    '| 指标 | 结果 |', '| --- | --- |', '| 有效样本 | 31/31 |', '', '## 待确认', '',
    '| 待确认 | 建议 |', '| --- | --- |', '| 登录态 | 固定账号 |', '', '[技术文档](review.md)',
  ].join('\n') });
  const web = await serve({ room: f.room, host: '127.0.0.1', port: 0 });
  t.after(async () => { f.room.close(); await web.close(); f.store.close(); rmSync(report); rmdirSync(cwd); });
  const base = `http://127.0.0.1:${web.port}`;
  const member = { headers: { authorization: `Bearer ${f.tokens.bob}` } };
  const initial = await (await fetch(`${base}/api/bootstrap`, member)).json();
  assert.equal(initial.overview.title, '性能评审');
  assert.equal(initial.overview.messageId, recap.id);
  assert.match(initial.overview.goal, /同一台机器/);
  assert.deepEqual(initial.overview.points, [
    { label: '当前进展', text: '当前已完成采样脚本，可按场景输出重复采样结果。' },
    { label: '实测结果', text: '有效样本 31/31' },
    { label: '待确认', text: '登录态' },
  ]);
  assert.deepEqual(initial.overview.files.map(({ name }) => name), ['review.md']);
  const updated = f.store.addMessage({ role: 'agent', authorId: 'codex', authorName: 'Codex',
    text: '当前已补齐采样数据，可以检查新增的采样结果。\n\n更新版见 [评审稿](review.md)。' });
  f.room.addNote(f.alice, { kind: 'decision', text: '双方统一使用测试账号' });
  const latest = await (await fetch(`${base}/api/bootstrap`, member)).json();
  assert.equal(latest.overview.messageId, recap.id);
  assert.deepEqual(latest.overview.points[0], { label: '共同结论', text: '双方统一使用测试账号' });
  assert.deepEqual(latest.overview.points[1], { label: '当前进展', text: '当前已补齐采样数据，可以检查新增的采样结果。' });
  assert.deepEqual(latest.overview.files.map(({ name, messageId }) => [name, messageId]), [['review.md', updated.id]]);
});

test('成员可读取本房间和来源会话明确链接的 Codex 生成图片', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'grouptalk-generated-images-'));
  const cwd = join(temp, 'project');
  const codexHome = join(temp, 'codex');
  const generated = join(codexHome, 'generated_images');
  const rooms = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003'];
  const [current, source, other] = rooms.map((id) => join(generated, id, 'plot.png'));
  const text = join(generated, rooms[0], 'notes.md');
  mkdirSync(cwd);
  mkdirSync(generated, { recursive: true });
  const f = await fixture({ cwd });
  [f.store.state.threadId, f.store.state.sourceThreadId] = rooms;
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  let web;
  try { web = await serve({ room: f.room, host: '127.0.0.1', port: 0 }); }
  finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
  t.after(async () => {
    f.room.close(); await web.close(); f.store.close();
    for (const path of [current, source, other, text]) rmSync(path, { force: true });
    for (const path of [...rooms.map((id) => join(generated, id)), generated, codexHome, cwd, temp]) rmdirSync(path);
  });
  for (const id of rooms) mkdirSync(join(generated, id));
  for (const path of [current, source, other, text]) writeFileSync(path, '验收内容');
  const reply = f.store.addMessage({ role: 'agent', authorId: 'codex', authorName: 'Codex',
    text: `![房间生成](<${current}>) ![来源生成](<${source}>) ![其他会话](<${other}>) [文本](<${text}>)` });
  f.room.commit();
  const base = `http://127.0.0.1:${web.port}`;
  const member = { headers: { authorization: `Bearer ${f.tokens.alice}` } };
  const { sourceFiles } = await (await fetch(`${base}/api/bootstrap`, member)).json();
  assert.deepEqual(sourceFiles[reply.id].map(({ label, imageType }) => [label, imageType]),
    [['房间生成', 'image/png'], ['来源生成', 'image/png']]);
  const result = await fetch(`${base}/api/source-files/${reply.id}/0`, member);
  assert.equal(result.status, 200);
  assert.equal(await result.text(), '验收内容');
});
