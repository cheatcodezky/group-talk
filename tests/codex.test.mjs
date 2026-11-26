import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAgent, readLocalTranscript } from '../skills/grouptalk/server/codex.mjs';
import { gitInspectionCommand, inspectGit } from '../skills/grouptalk/server/git-inspection.mjs';

class FakeRpc extends EventEmitter {
  calls = [];
  config = { layers: [], config: {} };
  async initialize() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'config/read') return this.config;
    if (method === 'model/list') return { data: [{ id: 'available-model', model: 'available-model', isDefault: true }] };
    if (method.startsWith('thread/')) return { thread: { id: 'shared', turns: [] }, model: params.model };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  }
  respond(id, result) { this.lastResponse = { id, result }; }
  reject(id, message) { this.lastRejection = { id, message }; }
  close() {}
  notify(method, params = {}) { this.emit('notification', { method, params: { threadId: 'shared', ...params } }); }
}

test('共享线程关闭本机连接器和钩子，有历史命令规则时停用 shell', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'grouptalk-saved-rules-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'rules'));
  writeFileSync(join(folder, 'rules', 'default.rules'), 'prefix_rule(pattern=["demo"], decision="allow")');
  const rpc = new FakeRpc();
  rpc.config = { layers: [{ name: { type: 'user', file: join(folder, 'config.toml') } }], config: { mcp_servers: { demo: { enabled: true } } } };
  const agent = new CodexAgent({ cwd: folder, rpcFactory: () => rpc });
  await agent.initialize({ sourceThreadId: 'source' });
  assert.equal(agent.shellRestricted, true);
  const { config, sandbox, approvalPolicy } = rpc.calls.find(({ method }) => method === 'thread/fork').params;
  assert.deepEqual(config, { 'features.apps': false, 'features.plugins': false, 'features.hooks': false, 'mcp_servers.demo.enabled': false, 'features.shell_tool': false });
  assert.equal(sandbox, 'read-only');
  assert.equal(approvalPolicy, 'on-request');
  agent.close();
});

test('Codex 选择可用默认模型、按模式设置沙箱、合并流式回复并记录执行证据', async () => {
  const rpc = new FakeRpc();
  const agent = new CodexAgent({ cwd: '/tmp/workspace', rpcFactory: () => rpc });
  await agent.initialize({});
  assert.equal(rpc.calls.find((c) => c.method === 'thread/start').params.model, 'available-model');
  assert.equal(rpc.calls.find((c) => c.method === 'thread/start').params.approvalPolicy, 'on-request');
  let accepted = 0; let partial = ''; const progress = [];
  const result = agent.run({ prompt: 'test', mode: 'ask', id: 'message-1', onAccepted: () => accepted++, onDelta: (text) => partial = text, onProgress: (event) => progress.push(event) });
  await Promise.resolve();
  rpc.notify('turn/started', { turn: { id: 'turn-1' } });
  rpc.notify('item/agentMessage/delta', { itemId: 'answer', delta: '共同' });
  rpc.notify('item/agentMessage/delta', { itemId: 'answer', delta: '方案' });
  rpc.notify('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'node --test', exitCode: 0, aggregatedOutput: 'passed' } });
  rpc.notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 300, outputTokens: 30 } } });
  rpc.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  const response = await result;
  assert.equal(accepted, 1);
  assert.equal(partial, '共同方案'); assert.equal(response.text, '共同方案');
  assert.equal(response.usage.inputTokens, 300);
  assert.equal(progress[0].type, 'commandResult');
  assert.deepEqual(rpc.calls.find((c) => c.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly' });
  const execution = agent.run({ prompt: 'execute', mode: 'execute', id: 'message-2', onAccepted() {}, onDelta() {}, onProgress() {} });
  await Promise.resolve();
  rpc.notify('turn/completed', { turn: { status: 'completed' } }); await execution;
  const policy = rpc.calls.filter((c) => c.method === 'turn/start')[1].params.sandboxPolicy;
  assert.equal(policy.type, 'workspaceWrite'); assert.equal(policy.networkAccess, false);
  assert.deepEqual(policy.writableRoots, ['/tmp/workspace']);
  assert.ok(rpc.calls.filter(({ method }) => method === 'turn/start').every(({ params }) => params.approvalPolicy === 'on-request' && params.approvalsReviewer === 'user'));
  agent.close();
});

test('只读 Git 遵守组织限制，已登录运行时可执行不触发钩子的命令', async () => {
  const command = gitInspectionCommand({ operation: 'diff', base: '发布/版本', head: 'HEAD' });
  const methods = [];
  let requirements = { featureRequirements: { hooks: false }, allowedLoginMethods: ['api'] };
  const rpc = { async request(method, params) {
    methods.push(method);
    if (method === 'config/read') return { layers: [] };
    if (method === 'configRequirements/read') return { requirements };
    assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.deepEqual(params.command, command);
    return { exitCode: 0, stdout: 'M\tpreview.md\n' };
  } };
  const options = { rpc, cwd: '/tmp/workspace', command };
  assert.deepEqual(await inspectGit(options), { text: 'M\tpreview.md', truncated: false });
  methods.length = 0;
  requirements = { allowedSandboxModes: ['workspace-write'] };
  await assert.rejects(inspectGit(options), /无法独立核对组织命令策略/);
  assert.deepEqual(methods, ['config/read', 'configRequirements/read']);
});

test('只处理当前执行回合的单次审批，拒绝持久授权，并在回合结束时撤下审批', async () => {
  const rpc = new FakeRpc();
  const agent = new CodexAgent({ cwd: '/tmp/workspace', rpcFactory: () => rpc });
  await agent.initialize({});
  const requested = [];
  const progress = [];
  let removed = 0;
  const run = agent.run({ prompt: 'execute', mode: 'execute', id: 'test-request', onAccepted() {}, onDelta() {},
    onProgress: (event) => progress.push(event),
    onApproval: (preview, reply) => { requested.push({ preview, reply }); return () => { removed++; }; },
  });
  await Promise.resolve();
  const request = (id, changes = {}) => agent.handleRequest({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'shared', turnId: 'turn-1', itemId: 'command', ...changes } });
  rpc.notify('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'command', command: 'private command', cwd: '/tmp/workspace' } });
  assert.doesNotMatch(JSON.stringify(progress), /private command/);
  request(1, { turnId: 'old' });
  assert.deepEqual(rpc.lastResponse, { id: 1, result: { decision: 'decline' } });
  request(2, { availableDecisions: ['acceptForSession', 'decline'] });
  assert.deepEqual(rpc.lastResponse, { id: 2, result: { decision: 'decline' } });
  request(3, { availableDecisions: ['accept', 'decline'] });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].preview.detail, 'private command');
  assert.equal(rpc.lastResponse.id, 2);
  requested[0].reply('accept');
  assert.deepEqual(rpc.lastResponse, { id: 3, result: { decision: 'accept' } });
  request(4);
  rpc.notify('serverRequest/resolved', { requestId: 4 });
  assert.equal(removed, 1);
  request(5);
  agent.handleRequest({ id: 6, method: 'item/permissions/requestApproval' });
  assert.deepEqual(rpc.lastResponse, { id: 6, result: { permissions: {}, scope: 'turn' } });
  rpc.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await run;
  assert.equal(removed, 2);
  agent.close();
});

test('运行时失败和中断不会被误报成功，审批不会静默批准', async () => {
  const rpc = new FakeRpc(); const agent = new CodexAgent({ cwd: '/tmp/workspace', rpcFactory: () => rpc });
  await agent.initialize({});
  const run = () => agent.run({ prompt: 'test', mode: 'ask', id: 'one', onAccepted() {}, onDelta() {}, onProgress() {} });
  const pending = run(); await Promise.resolve();
  rpc.notify('turn/completed', { turn: { status: 'failed', error: { message: '{"error":{"code":"model_not_found","message":"model not supported when using Codex with a ChatGPT account"}}' } } });
  await assert.rejects(pending, (error) => error.unavailable && /无法调用/.test(error.message));
  const interrupted = run(); await Promise.resolve();
  await agent.interrupt();
  assert.equal(rpc.calls.at(-1).method, 'turn/interrupt');
  rpc.notify('turn/completed', { turn: { status: 'interrupted' } });
  assert.equal((await interrupted).status, 'cancelled');
  agent.handleRequest({ id: 10, method: 'item/commandExecution/requestApproval' });
  assert.equal(rpc.lastResponse.result.decision, 'decline');
  agent.handleRequest({ id: 11, method: 'unknown/method' });
  assert.equal(rpc.lastRejection.id, 11);
  agent.close();
});

test('桌面历史兼容读取只显示用户与助手文本，不泄露开发者指令、推理和工具数据', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'grouptalk-history-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, [
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'private instructions' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '一起讨论需求' }] } },
    { type: 'response_item', payload: { type: 'reasoning', text: 'hidden reasoning' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我们比较两个方案' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', text: 'private tool output' } },
  ].map((record) => JSON.stringify(record)).join('\n'));
  const history = await readLocalTranscript(path);
  assert.equal(history[0].items.length, 2);
  assert.equal(history[0].items[0].content[0].text, '一起讨论需求');
  assert.equal(history[0].items[1].text, '我们比较两个方案');
  assert.doesNotMatch(JSON.stringify(history), /private|hidden/);
});

test('用量按线程累计差值计算完整回合，包含多次模型请求且排除继承的历史用量', async () => {
  const rpc = new FakeRpc(); const agent = new CodexAgent({ cwd: '/tmp/workspace', rpcFactory: () => rpc });
  await agent.initialize({});
  const run = () => agent.run({ prompt: 'test', mode: 'ask', id: 'one', onAccepted() {}, onDelta() {}, onProgress() {} });
  const first = run(); await Promise.resolve();
  rpc.notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1200, outputTokens: 120, cachedInputTokens: 400 }, last: { inputTokens: 200, outputTokens: 20, cachedInputTokens: 100 } } });
  rpc.notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1650, outputTokens: 165, cachedInputTokens: 600 }, last: { inputTokens: 450, outputTokens: 45, cachedInputTokens: 200 } } });
  rpc.notify('turn/completed', { turn: { id: 'old-turn', status: 'completed' } });
  assert.ok(agent.current, '不相关的旧回合不能结束当前任务');
  rpc.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  const usage = (await first).usage;
  assert.equal(usage.inputTokens, 650); assert.equal(usage.outputTokens, 65); assert.equal(usage.cachedInputTokens, 300);
  const second = run(); await Promise.resolve();
  rpc.notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1700, outputTokens: 170, cachedInputTokens: 610 }, last: { inputTokens: 50, outputTokens: 5, cachedInputTokens: 10 } } });
  rpc.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  assert.equal((await second).usage.inputTokens, 50);
  agent.close();
});
