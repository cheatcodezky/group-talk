import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, FakeAgent, message, until } from './helpers.mjs';
import { Store } from '../skills/grouptalk/server/store.mjs';
import { parseCoreUpdate } from '../skills/grouptalk/server/core-info.mjs';
import { roomOverview } from '../skills/grouptalk/server/overview.mjs';

const block = (upsert, remove = []) => '已整理。\n\n' + '```grouptalk-core\n' + JSON.stringify({ version: 1, upsert, remove }) + '\n```';
const item = (id, content, kind = 'conclusion') => ({ id, title: id, content, kind });

test('核心信息按稳定 id 更新、保留和删除，所有成员一致且重启保留来源版本', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'grouptalk-core-'));
  const path = join(dir, 'room.sqlite');
  const outputs = [
    block([item('scope', '首版范围'), item('image', '沿用原配图', 'artifact')]),
    block([item('scope', '新范围'), item('question', '还需确认', 'question')]),
    block([], ['scope']),
  ];
  const agent = new FakeAgent({ respond: () => outputs.shift() });
  const store = new Store(path);
  const f = await fixture({ store, agent });
  t.after(() => { f.close(); rmSync(dir, { recursive: true, force: true }); });
  const send = async () => {
    const task = f.room.post(f.alice, message('更新核心信息', 'ask')).task;
    await until(() => task.status === 'completed');
    return task;
  };
  await send();
  const image = { ...store.state.coreItems.find(({ id }) => id === 'image') };
  const second = await send();
  const scope = store.state.coreItems.find(({ id }) => id === 'scope');
  assert.equal(scope.content, '新范围');
  assert.equal(scope.revision, 2);
  assert.equal(scope.taskId, second.id);
  assert.ok(store.state.messages.find(({ id }) => id === scope.messageId)?.coreUpdate);
  assert.deepEqual(store.state.coreItems.find(({ id }) => id === 'image'), image);
  assert.deepEqual(f.room.snapshot(f.owner).coreItems, f.room.snapshot(f.bob).coreItems);
  assert.deepEqual(roomOverview(store.state, {}).coreItems, store.state.coreItems);
  const prompt = JSON.parse(agent.calls[1].prompt.slice(agent.calls[1].prompt.indexOf('{')));
  assert.deepEqual(prompt.sharedCoreItems.map(({ id }) => id), ['scope', 'image']);
  assert.match(prompt.coreInfoOutput, /grouptalk-core/);
  await send();
  assert.deepEqual(store.state.coreItems.map(({ id }) => id), ['image', 'question']);
  const reloaded = new Store(path);
  assert.deepEqual(reloaded.state.coreItems, store.state.coreItems);
  reloaded.close();
});

test('无效批次原子拒绝，普通发言、自动参与和中断结果不能改核心信息', async (t) => {
  const agent = new FakeAgent({ respond: () => block([item('keep', '原值')]) });
  const f = await fixture({ agent });
  t.after(f.close);
  let task = f.room.post(f.owner, message('发布核心信息', 'ask')).task;
  await until(() => task.status === 'completed');
  const original = structuredClone(f.store.state.coreItems);
  agent.respond = () => block([item('keep', '应被整体拒绝'), { ...item('invalid', '无效类型'), kind: 'execute' }]);
  task = f.room.post(f.owner, message('更新核心信息', 'ask')).task;
  await until(() => task.status === 'completed');
  assert.deepEqual(f.store.state.coreItems, original);
  assert.match(task.progress.at(-1).text, /核心信息未更新/);
  f.room.post(f.bob, message(block([item('keep', '成员伪造更新')])));
  assert.deepEqual(f.store.state.coreItems, original);
  agent.respond = () => block([item('keep', '自动参与更新')]);
  f.store.state.settings.jevEnabled = true;
  task = f.room.enqueue({ trigger: 'auto', request: '请补充观点' });
  await f.room.pump();
  assert.equal(task.status, 'completed');
  assert.deepEqual(f.store.state.coreItems, original);
  agent.run = async () => ({ status: 'cancelled', text: block([item('keep', '中断更新')]) });
  task = f.room.post(f.owner, message('整理核心信息', 'ask')).task;
  await until(() => task.status === 'cancelled');
  assert.deepEqual(f.store.state.coreItems, original);
});

test('只接受单个顶层协议块，重复标识符、格式错误和示例嵌套被拒绝', () => {
  assert.equal(parseCoreUpdate('普通答复'), null);
  assert.equal(parseCoreUpdate('> ```grouptalk-core\n> {"version":1,"upsert":[],"remove":[]}\n> ```'), null);
  assert.throws(() => parseCoreUpdate('```grouptalk-core\nnot json\n```'), /JSON/);
  assert.throws(() => parseCoreUpdate(block([item('same', 'a'), item('same', 'b')])), /重复/);
  assert.throws(() => parseCoreUpdate(block([item('same', 'a')], ['same'])), /重复/);
  assert.throws(() => parseCoreUpdate(block([item('../file', 'a')])), /标识符/);
  assert.throws(() => parseCoreUpdate(block([]) + '\n' + block([])), /一个/);
});
