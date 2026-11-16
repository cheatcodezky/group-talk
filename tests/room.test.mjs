import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, FakeAgent, message, until, delay } from './helpers.mjs';
import { Store } from '../server/store.mjs';

test('多人自由讨论不会调用 Agent，点名会包含所有人的未提交观点与引用', async (t) => {
  const f = await fixture(); t.after(f.close);
  const first = f.room.post(f.alice, message('我们需要缓存搜索结果，TTL 建议十分钟。')).message;
  f.room.post(f.bob, message('我担心不同用户之间的数据隔离。', 'chat', { replyTo: first.id }));
  await delay(30);
  assert.equal(f.agent.calls.length, 0);
  const { task } = f.room.post(f.owner, message('比较方案，保留分歧。', 'ask'));
  await until(() => task.status === 'completed');
  const prompt = JSON.parse(f.agent.calls[0].prompt.slice(f.agent.calls[0].prompt.indexOf('{')));
  assert.deepEqual(prompt.discussion.map((m) => m.name), ['小王', '小李', '房主']);
  assert.match(prompt.discussion[1].replyTo, /TTL/);
  assert.match(prompt.currentRequest.text, /保留分歧/);
  assert.equal(task.contextCount, 3);
  assert.equal(f.store.state.messages.at(-1).role, 'agent');
  assert.equal(f.store.state.usage.inputTokens, 100);
});

test('引用与代码中的点名不触发；显式开头点名直接触发；重发去重', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.room.post(f.alice, message('他说“@Codex 帮我看看”，这只是引用。'));
  f.room.post(f.bob, message('```\n@Codex 不要执行\n```'));
  assert.equal(f.store.state.tasks.length, 0);
  const input = message('@Codex 请比较刚才的意见。');
  const first = f.room.post(f.alice, input);
  const duplicate = f.room.post(f.alice, input);
  assert.equal(duplicate.message.id, first.message.id);
  assert.equal(duplicate.task.id, first.task.id);
  await until(() => first.task.status === 'completed');
  assert.equal(f.agent.calls.length, 1);
});

test('并发调用串行执行，执行期间新聊天留到下一批，不重复提交旧观点', async (t) => {
  const f = await fixture({ agent: new FakeAgent({ duration: 60 }) }); t.after(f.close);
  const first = f.room.post(f.alice, message('先分析 A。', 'ask')).task;
  await until(() => first.status === 'running');
  f.room.post(f.bob, message('新增限制：必须支持手机。'));
  const second = f.room.post(f.bob, message('再分析 B。', 'ask')).task;
  assert.equal(second.status, 'queued');
  await until(() => second.status === 'completed');
  assert.equal(f.agent.maxActive, 1);
  const p = f.agent.calls[1].prompt;
  assert.match(p, /必须支持手机/);
  const data = JSON.parse(p.slice(p.indexOf('{')));
  assert.deepEqual(data.discussion.map((m) => m.text), ['新增限制：必须支持手机。', '再分析 B。']);
  assert.equal(data.currentRequest.text, '再分析 B。');
});

test('执行权限在服务端校验，普通讨论和 Jev 不获得执行权限', async (t) => {
  const f = await fixture(); t.after(f.close);
  assert.throws(() => f.room.post(f.alice, message('写文件', 'execute')), /执行权限/);
  assert.throws(() => f.room.configure(f.bob, { allowExecution: true }), /房主/);
  f.room.configure(f.owner, { allowExecution: true });
  const task = f.room.post(f.alice, message('创建一个小函数并验证。', 'execute')).task;
  await until(() => task.status === 'completed');
  assert.equal(f.agent.calls[0].mode, 'execute');
});

test('取消排队任务和正在运行的任务，其他成员不能停止别人的任务', async (t) => {
  const f = await fixture({ agent: new FakeAgent({ duration: 500 }) }); t.after(f.close);
  const first = f.room.post(f.alice, message('分析 A', 'ask')).task;
  await until(() => first.status === 'running');
  const second = f.room.post(f.bob, message('分析 B', 'ask')).task;
  await assert.rejects(f.room.cancel(f.bob, first.id), /自己/);
  await f.room.cancel(f.bob, second.id);
  assert.equal(second.status, 'cancelled');
  await f.room.cancel(f.alice, first.id);
  await until(() => first.status === 'cancelled');
  assert.equal(f.agent.calls.length, 1);
});

test('Jev 未配置可运行；开关开启失败；有密钥时批量裁决触发只读协作', async (t) => {
  const f = await fixture(); t.after(f.close);
  assert.throws(() => f.room.configure(f.owner, { jevEnabled: true }), /TYPESAFE_API_KEY/);
  assert.equal(f.store.state.settings.jevEnabled, false);
  let calls = 0;
  f.room.judge = { ready: true, evaluate: async () => { calls++; return { gap: 0.98, clarify: 0.1, tokens: 1200 }; } };
  f.room.configure(f.owner, { jevEnabled: true });
  f.room.post(f.alice, message('这个缓存隔离方式有资料支持吗？'));
  f.room.post(f.bob, message('我们现在缺少用户权限边界的信息。'));
  await until(() => f.store.state.tasks.some((task) => task.status === 'completed'));
  assert.equal(calls, 1);
  assert.equal(f.store.state.tasks[0].trigger, 'auto');
  assert.equal(f.agent.calls[0].mode, 'ask');
  assert.equal(f.store.state.judge.inputTokens, 1200);
  assert.equal(f.store.state.judge.cost, 1200 / 1e6 * 0.042);
});

test('关闭 Jev 丢弃在途裁决；故障降级但点名仍然可用', async (t) => {
  let resolve;
  const f = await fixture({ judge: { ready: true, evaluate: () => new Promise((r) => { resolve = r; }) } }); t.after(f.close);
  f.room.configure(f.owner, { jevEnabled: true });
  f.room.post(f.alice, message('等待一个裁决'));
  await until(() => Boolean(resolve));
  f.room.configure(f.owner, { jevEnabled: false });
  resolve({ gap: 1, clarify: 1, tokens: 100 });
  await delay(30);
  assert.equal(f.agent.calls.length, 0);
  assert.equal(f.store.state.judge.status, 'off');
  f.room.judge = { ready: true, evaluate: async () => { throw new Error('超时'); } };
  f.room.configure(f.owner, { jevEnabled: true });
  f.room.post(f.bob, message('新讨论'));
  await until(() => f.store.state.judge.status === 'degraded');
  assert.equal(f.store.state.settings.jevEnabled, false);
  const task = f.room.post(f.owner, message('请继续参与', 'ask')).task;
  await until(() => task.status === 'completed');
});

test('点名绕过 Jev 否决，过期裁决不会额外唤起 Agent', async (t) => {
  let resolve;
  const f = await fixture({ judge: { ready: true, evaluate: () => new Promise((r) => { resolve = r; }) } }); t.after(f.close);
  f.room.configure(f.owner, { jevEnabled: true });
  f.room.post(f.alice, message('普通讨论'));
  await until(() => Boolean(resolve));
  const task = f.room.post(f.bob, message('@Codex 明确点名')) .task;
  resolve({ gap: 1, clarify: 0, tokens: 100 });
  await until(() => task.status === 'completed');
  assert.equal(f.agent.calls.length, 1);
  assert.equal(task.trigger, 'mention');
});

test('不确定的提交暂停队列且不自动重跑，房主检查后恢复', async (t) => {
  const f = await fixture({ agent: new FakeAgent({ fail: 'uncertain' }) }); t.after(f.close);
  const first = f.room.post(f.alice, message('实现任务', 'ask')).task;
  const second = f.room.post(f.bob, message('另一个任务', 'ask')).task;
  await until(() => first.status === 'needs_review');
  assert.equal(f.store.state.queuePaused, true);
  assert.equal(second.status, 'queued');
  assert.equal(f.agent.calls.length, 1);
  f.agent.fail = null;
  f.room.recover(f.owner);
  await until(() => second.status === 'completed');
  assert.equal(first.status, 'cancelled');
  assert.equal(f.agent.calls.length, 2);
});

test('重启保留身份、聊天、记录和同一协作线程；运行中任务标记待检查', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'grouptalk-persist-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'room.sqlite');
  const f = await fixture({ store: new Store(path) });
  f.room.post(f.alice, message('持久化观点'));
  f.room.addNote(f.bob, { kind: 'question', text: '是否按用户隔离？' });
  f.store.state.tasks.push({ id: 'interrupted-task', status: 'running' }); f.store.save();
  const token = f.tokens.alice; const threadId = f.store.state.threadId;
  f.close();
  const store = new Store(path); t.after(() => store.close());
  assert.equal(store.state.threadId, threadId);
  assert.equal(store.state.messages[0].text, '持久化观点');
  assert.equal(store.state.decisions[0].text, '是否按用户隔离？');
  assert.equal(store.state.tasks[0].status, 'needs_review');
  assert.equal(store.state.queuePaused, true);
  assert.equal(store.state.members.find((m) => m.name === '小王').tokenHash.length, 64);
  const { Room } = await import('../server/room.mjs');
  const agent = new FakeAgent();
  const room = new Room({ store, agent, judge: { ready: false }, cwd: dir }); t.after(() => room.close());
  await room.initialize();
  assert.equal(room.authenticate(token).name, '小王');
  assert.equal(agent.initialization.threadId, threadId);
});

test('共同记录保留作者与分歧，更新和邀请重置受权限约束', async (t) => {
  const f = await fixture(); t.after(f.close);
  const note = f.room.addNote(f.alice, { kind: 'decision', text: '缓存按用户隔离，TTL 仍有分歧。' });
  assert.throws(() => f.room.updateNote(f.bob, note.id, { done: true }), /自己/);
  f.room.updateNote(f.alice, note.id, { done: true });
  assert.equal(note.done, true);
  const old = f.store.state.invite;
  assert.throws(() => f.room.rotateInvite(f.bob), /房主/);
  f.room.rotateInvite(f.owner);
  assert.throws(() => f.room.join({ key: old, name: '新成员' }), /撤销/);
  assert.equal(f.room.authenticate(f.tokens.bob).name, '小李');
  assert.equal('tokenHash' in f.room.snapshot(f.owner).members[0], false);
  assert.equal('hostKey' in f.room.snapshot(f.owner), false);
});

test('来源历史只导入一次且不会当作新请求重发', async (t) => {
  const history = [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: '原始需求' }] }, { type: 'agentMessage', text: '已有分析' }] }];
  const f = await fixture({ sourceThreadId: 'original', agent: new FakeAgent({ history }) }); t.after(f.close);
  assert.equal(f.store.state.messages.length, 2);
  assert.equal(f.store.state.deliveredSeq, 2);
  const task = f.room.post(f.alice, message('请结合继承的需求继续讨论', 'ask')).task;
  await until(() => task.status === 'completed');
  const prompt = JSON.parse(f.agent.calls[0].prompt.slice(f.agent.calls[0].prompt.indexOf('{')));
  assert.equal(prompt.discussion.length, 1);
  assert.equal(f.store.state.sourceThreadId, 'original');
});

test('房主撤销执行权限后，尚未开始的成员任务不会继续运行', async (t) => {
  const f = await fixture({ agent: new FakeAgent({ duration: 50 }) }); t.after(f.close);
  f.room.configure(f.owner, { allowExecution: true });
  const first = f.room.post(f.owner, message('正在分析', 'ask')).task;
  await until(() => first.status === 'running');
  const queued = f.room.post(f.alice, message('排队实现', 'execute')).task;
  f.room.configure(f.owner, { allowExecution: false });
  await until(() => queued.status === 'failed');
  assert.match(queued.error, /撤销/);
  assert.equal(f.agent.calls.length, 1);
});

test('设置更新整体校验，不留下部分修改；消息标识不能重复用于不同正文', async (t) => {
  const f = await fixture(); t.after(f.close);
  assert.throws(() => f.room.configure(f.owner, { allowExecution: true, title: '' }), /名称/);
  assert.equal(f.store.state.settings.allowExecution, false);
  const input = message('第一份内容'); f.room.post(f.alice, input);
  assert.throws(() => f.room.post(f.alice, { ...input, text: '不同内容' }), /不同内容/);
});

test('Jev 低概率保持静默，冷却期内不会反复触发', async (t) => {
  let probability = 0.1; let calls = 0;
  const f = await fixture({ cooldownMs: 1000, judge: { ready: true, evaluate: async () => { calls++; return { gap: probability, clarify: 0.1, tokens: 100 }; } } }); t.after(f.close);
  f.room.configure(f.owner, { jevEnabled: true });
  f.room.post(f.alice, message('普通闲聊'));
  await until(() => calls === 1); await delay(5);
  assert.equal(f.agent.calls.length, 0);
  probability = 0.99;
  f.room.post(f.bob, message('有明确的信息缺口'));
  await until(() => f.store.state.tasks[0]?.status === 'completed');
  f.room.post(f.alice, message('紧接着的下一句'));
  await delay(50);
  assert.equal(f.agent.calls.length, 1); assert.equal(calls, 2);
});
