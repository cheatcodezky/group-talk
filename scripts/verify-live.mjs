import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { CodexAgent } from '../server/codex.mjs';
import { JevJudge } from '../server/jev.mjs';
import { Room } from '../server/room.mjs';
import { serve } from '../server/http.mjs';

const root = mkdtempSync(join(tmpdir(), 'grouptalk-live-'));
const workspace = join(root, 'workspace'); mkdirSync(workspace);
const store = new Store(join(root, 'room.sqlite'));
const agent = new CodexAgent({ cwd: workspace, model: process.env.GROUPTALK_TEST_MODEL });
const room = new Room({ store, agent, judge: new JevJudge(), cwd: workspace });
let web;
let sourceAgent;
const report = { date: new Date().toISOString(), workspace, checks: [], passed: false, jevLive: false };
const check = (text) => { report.checks.push(text); console.log(`PASS ${text}`); };
async function waitForTask(id, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const task = store.state.tasks.find((task) => task.id === id);
    if (['failed', 'needs_review'].includes(task.status)) throw new Error(task.error);
    if (task.status === 'completed') return task;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('真实 Codex 回合超时');
}
async function waitForSideReply(chat, questionId) {
  const end = Date.now() + 185000;
  while (Date.now() < end) {
    const question = chat.questions.find((entry) => entry.id === questionId);
    if (question.status === 'completed') return question;
    if (question.status === 'failed') throw new Error(question.error);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('真实 Codex 侧聊超时');
}
try {
  console.log(`正在启动真实 Codex 验证，隔离工作区：${workspace}`);
  sourceAgent = new CodexAgent({ cwd: workspace, model: process.env.GROUPTALK_TEST_MODEL });
  await sourceAgent.initialize({});
  const sourceResult = await sourceAgent.run({ prompt: '这是一段准备分享给小组的来源对话。项目代号是 ORCHID-741，请记住。只回复“已记住”，不要调用工具。', mode: 'ask', id: randomUUID(), onAccepted() {}, onProgress() {}, onDelta() {} });
  report.sourceThreadId = sourceAgent.threadId;
  report.sourceSetupUsage = sourceResult.usage;
  room.sourceThreadId = sourceAgent.threadId;
  sourceAgent.close(); sourceAgent = null;
  await room.initialize();
  report.model = agent.model;
  report.binary = agent.rpc.child.spawnfile;
  web = await serve({ room, host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${web.port}`;
  const post = async (path, data, token) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
    const result = await response.json(); assert.ok(response.ok, result.error); return result;
  };
  const owner = await post('/api/join', { key: store.state.hostKey, name: '主持人' });
  const alice = await post('/api/join', { key: store.state.invite, name: '小王' });
  const bob = await post('/api/join', { key: store.state.invite, name: '小李' });
  const send = (who, text, mode = 'chat') => post('/api/messages', { text, mode, clientId: randomUUID() }, who.token);
  const inherited = await send(owner, '请回忆来源对话中已确定的项目代号。只回答代号，不要调用工具。', 'ask');
  const inheritedTask = await waitForTask(inherited.task.id);
  assert.match(inheritedTask.result, /ORCHID-741/);
  assert.notEqual(store.state.threadId, report.sourceThreadId);
  assert.ok(store.state.messages.some((message) => message.history));
  check('从已有对话创建独立协作分支，真实继承原对话中的独有上下文');
  const previousTaskCount = store.state.tasks.length;
  await Promise.all([send(alice, '我建议缓存有效期设为 137 秒，这个数字是我们的验证约束。'), send(bob, '我要求缓存必须按 tenantId 隔离，不能跨租户共享。')]);
  assert.equal(store.state.tasks.length, previousTaskCount);
  check('两位成员同时自由发言，不触发模型');
  const first = await send(owner, '请根据小王和小李的观点，给出一个共同方案和一个待确认问题。明确写出每人的名字及其约束。不要调用工具，控制在 150 字内。', 'ask');
  const second = await send(bob, '补充约束：缓存最多保存 23 项，请记住这个限制。', 'chat');
  const queued = await send(alice, '请只用一句话列出我们目前的三个约束，必须包含 137、tenantId、23，不要调用工具。', 'ask');
  const firstTask = await waitForTask(first.task.id);
  assert.match(firstTask.result, /137/); assert.match(firstTask.result, /tenantId/);
  assert.match(firstTask.result, /小王/); assert.match(firstTask.result, /小李/);
  check('真实 Codex 读取两位参与者的观点并共同分析');
  const queuedTask = await waitForTask(queued.task.id);
  assert.match(queuedTask.result, /137/); assert.match(queuedTask.result, /tenantId/); assert.match(queuedTask.result, /23/);
  assert.ok(queuedTask.startedAt >= firstTask.finishedAt);
  assert.ok(queuedTask.contextTo >= second.message.seq);
  check('真实回合串行排队，下一轮补齐执行期间的新讨论并保留旧上下文');
  const pending = await send(alice, '新增讨论：隔离策略校验代号为 SILVER-92。');
  assert.ok(store.state.deliveredSeq < pending.message.seq);
  const { id: sideId } = await post('/api/side-chats', {
    title: '隔离策略', clientId: randomUUID(), anchorId: pending.message.id,
  }, alice.token);
  const side = store.state.sideChats.find((entry) => entry.id === sideId);
  const execution = await send(owner, '请实现一个最小可验证功能：创建 positive-sum.mjs，导出 positiveSum(values)，只累加数组中的正数；创建 positive-sum.test.mjs，使用 node:test 验证 [1,-2,3,0] 得到4以及空数组得到0。运行 node --test positive-sum.test.mjs。只修改这两个文件，不要安装依赖。最后简要报告验证结果。', 'execute');
  const { id: sideQuestionId } = await post(`/api/side-chats/${sideId}/messages`, {
    text: '请简短列出来源对话的项目代号、选定消息的隔离校验代号、以及小王建议的缓存秒数。只回答这些信息。',
    clientId: randomUUID(),
  }, bob.token);
  const main = store.state.tasks.find((task) => task.id === execution.task.id);
  assert.ok(['starting', 'running'].includes(main.status), '侧聊开始时主任务仍在处理');
  const [executedTask, sideReply] = await Promise.all([
    waitForTask(execution.task.id), waitForSideReply(side, sideQuestionId),
  ]);
  assert.match(sideReply.answer, /ORCHID-741/);
  assert.match(sideReply.answer, /SILVER-92/);
  assert.match(sideReply.answer, /137/);
  assert.equal(store.state.messages.some((entry) => entry.sideChat), false);
  const shared = await post(`/api/side-chats/${sideId}/share`, { questionId: sideQuestionId }, bob.token);
  assert.equal(shared.text, sideReply.answer);
  assert.equal(shared.sideChat.id, sideId);
  check('普通成员使用带群聊及未提交消息背景的真实 Codex 侧聊，主任务同时继续，选定答复可带回主群');
  const output = execFileSync(process.execPath, ['--test', 'positive-sum.test.mjs'], { cwd: workspace, encoding: 'utf8' });
  assert.match(readFileSync(join(workspace, 'positive-sum.mjs'), 'utf8'), /positiveSum/);
  assert.match(output, /pass 2/);
  assert.ok(executedTask.progress.some((event) => event.type === 'commandResult'));
  check('真实 Codex 在指定工作区写入代码、运行测试，外部再次执行验证通过');
  const snapshotResponse = await fetch(`${base}/api/bootstrap`, { headers: { authorization: `Bearer ${alice.token}` } });
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.tasks.filter((task) => task.status === 'completed').length, 4);
  assert.equal(snapshot.messages.filter((message) => message.role === 'agent' && !message.history).length, 4);
  assert.equal(snapshot.threadId, store.state.threadId);
  assert.equal(snapshot.sideChats[0].questions[0].sharedMessageId, shared.id);
  check('其他成员读取同一个协作线程的全部讨论、回复与执行结果');
  if (room.judge.ready) {
    const result = await room.judge.evaluate({ topic: '缓存需求', messages: [{ text: '我们不知道 tenantId 的边界，应该先澄清。' }] });
    assert.equal(typeof result.clarify, 'number'); report.jevLive = true; check('真实 Jev API 调用成功');
  }
  report.threadId = store.state.threadId;
  report.usage = store.state.usage;
  report.passed = true;
} catch (error) { report.error = error.stack; console.error(error.stack); process.exitCode = 1; }
finally {
  sourceAgent?.close();
  room.close(); if (web) await web.close(); store.close();
  const artifacts = resolve('artifacts'); mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'live-verification.json'), JSON.stringify(report, null, 2));
  console.log(`验证报告：${join(artifacts, 'live-verification.json')}`);
}
