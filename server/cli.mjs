#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeSync } from 'node:fs';
import { Store } from './store.mjs';
import { CodexAgent } from './codex.mjs';
import { JevJudge } from './jev.mjs';
import { Room } from './room.mjs';
import { serve } from './http.mjs';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '4317' }, host: { type: 'string', default: '0.0.0.0' },
  cwd: { type: 'string', default: process.cwd() }, data: { type: 'string', default: '.grouptalk' },
  thread: { type: 'string' }, model: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('GroupTalk\n\nnpm start -- [--thread 来源线程ID] [--cwd 项目目录] [--port 4317] [--host 0.0.0.0] [--data 数据目录] [--model 模型]\n\n默认新建协作会话。--thread 从已有 Codex 对话创建独立分支；重启时恢复同一个分支。\n可选环境变量：TYPESAFE_API_KEY、GROUPTALK_CODEX_BIN。没有 Jev 密钥仍可正常运行。');
  process.exit(0);
}
const cwd = resolve(values.cwd);
const dataPath = resolve(values.data);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口不正确');
mkdirSync(dataPath, { recursive: true, mode: 0o700 });
const lockPath = resolve(dataPath, 'server.lock');
function acquireLock() {
  try { const fd = openSync(lockPath, 'wx', 0o600); closeSync(fd); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lockPath, 'utf8'));
    try { process.kill(pid, 0); throw new Error(`此房间已由进程 ${pid} 运行，不能重复启动`); }
    catch (status) { if (status.code !== 'ESRCH' && status.code !== 'EINVAL') throw status; }
    unlinkSync(lockPath);
    const fd = openSync(lockPath, 'wx', 0o600); closeSync(fd);
  }
  // The lock is runtime state, never a project source file.
  const fd = openSync(lockPath, 'w');
  writeSync(fd, String(process.pid)); closeSync(fd);
}
acquireLock();
const store = new Store(resolve(dataPath, 'room.sqlite'));
if (values.thread && store.state.threadId && values.thread !== store.state.sourceThreadId) throw new Error('数据目录已绑定其他会话，请使用新的 --data 目录');
if (store.state.workspace && store.state.workspace !== cwd) throw new Error('数据目录已绑定其他工作区，请使用新的 --data 目录');
store.state.workspace = cwd; store.save();
const agent = new CodexAgent({ cwd, model: values.model });
const room = new Room({ store, agent, judge: new JevJudge(), cwd, sourceThreadId: values.thread });
let web;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  room.close();
  if (web) await web.close();
  store.close();
  try { unlinkSync(lockPath); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
try {
  console.log('正在连接本机 Codex，准备共享协作会话…');
  await room.initialize();
  web = await serve({ room, host: values.host, port });
  const base = `http://127.0.0.1:${web.port}`;
  console.log(`\nGroupTalk 已启动\n工作区: ${cwd}\n来源线程: ${store.state.sourceThreadId || '新会话'}\n协作线程: ${store.state.threadId}\n`);
  console.log(`房主入口: ${base}/#host=${store.state.hostKey}`);
  console.log(`本机邀请: ${base}/#invite=${store.state.invite}`);
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries || []) {
    if (entry.family === 'IPv4' && !entry.internal) console.log(`局域网邀请: http://${entry.address}:${web.port}/#invite=${store.state.invite}`);
  }
  console.log(`\nJev: ${room.judge.ready ? '已配置，可在房间中开启' : '未配置，使用 @Codex 点名模式'}\nCtrl+C 停止服务；同一数据目录重启会保留房间和协作线程。`);
} catch (error) { console.error(`启动失败: ${error.message}`); await stop(1); }
