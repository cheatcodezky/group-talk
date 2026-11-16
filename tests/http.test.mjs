import test from 'node:test';
import assert from 'node:assert/strict';
import { serve, invitationLinks } from '../skills/grouptalk/server/http.mjs';
import { fixture, message, until } from './helpers.mjs';

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
