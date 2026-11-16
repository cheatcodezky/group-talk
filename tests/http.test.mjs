import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, invitationLinks } from '../skills/grouptalk/server/http.mjs';
import { FakeAgent, fixture, message, until } from './helpers.mjs';
import { networkInterfaces } from 'node:os';
import { request } from 'node:http';
import { clientAddress, macFromNeighbors } from '../skills/grouptalk/server/neighbors.mjs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('留空时分配房主与成员昵称，连接地址只给房主并以实际连接为准', async (t) => {
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
  const member = await join(f.store.state.invite, '  ');
  assert.equal(owner.member.name, '房主');
  assert.equal(owner.member.role, 'host');
  assert.equal(secondOwner.member.name, '房主 · 2');
  assert.match(member.member.name, /^[\p{Script=Han}]+ \d{4}$/u);
  assert.ok(!('network' in member.member));
  const snapshot = async (token) => (await fetch(base + '/api/bootstrap', { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual((await snapshot(owner.token)).members.find(({ id }) => id === member.member.id).network, { ip: '127.0.0.1', mac });
  assert.ok((await snapshot(member.token)).members.every((entry) => !('network' in entry)));
  assert.ok(f.store.state.members.every((entry) => !('network' in entry)));
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

test('房主与成员可查看来源消息并下载明确链接的工作区产出', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'grouptalk-source-files-'));
  const cwd = join(temp, 'project');
  mkdirSync(cwd);
  const report = join(cwd, '设计 文档.md');
  const outside = join(temp, 'outside.md');
  const dotfile = join(cwd, '.private.md');
  const example = join(cwd, 'example.md');
  const alias = join(cwd, 'shortcut.md');
  for (const path of [report, outside, dotfile, example]) writeFileSync(path, '这是验收文件');
  if (process.platform !== 'win32') symlinkSync(outside, alias);
  const history = [{ items: [
    { type: 'userMessage', content: [{ type: 'text', text: `[用户引用](<${example}>)` }] },
    { type: 'agentMessage', text: `已完成 [设计文档](<${report}:12>)。\n[房间外](<${outside}>)\n[隐藏](<${dotfile}>)\n[软链接](<${alias}>)\n` +
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
  const [{ index, label, name }] = member.sourceFiles[agentMessage.id];
  assert.equal(Object.values(member.sourceFiles).flat().length, 1);
  assert.equal(label, '设计文档');
  assert.equal(name, '设计 文档.md');
  const endpoint = `/api/source-files/${agentMessage.id}/${index}`;
  assert.equal((await get(endpoint)).status, 401);
  const download = await get(endpoint, f.tokens.alice);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await download.text(), '这是验收文件');
  assert.equal((await get(`/api/source-files/${agentMessage.id}/1`, f.tokens.alice)).status, 404);
  rmSync(report);
  if (process.platform !== 'win32') symlinkSync(outside, report);
  assert.equal((await get(endpoint, f.tokens.alice)).status, 404);
});
