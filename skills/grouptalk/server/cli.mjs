#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeSync } from 'node:fs';
import { Store, digest } from './store.mjs';
import { CodexAgent } from './codex.mjs';
import { JevJudge } from './jev.mjs';
import { Room } from './room.mjs';
import { invitationLinks, serve } from './http.mjs';

const { values } = parseArgs({ options: {
  port: { type: 'string' }, host: { type: 'string', default: '0.0.0.0' },
  cwd: { type: 'string', default: process.cwd() }, data: { type: 'string' },
  thread: { type: 'string' }, model: { type: 'string' },
  'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' },
  share: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log(`GroupTalk

node server/cli.mjs [--share] [--thread 来源线程ID] [--cwd 项目目录]
                   [--port 端口] [--host 地址] [--data 数据目录] [--model 模型]
                   [--tls-cert 证书文件 --tls-key 私钥文件]

--share 默认选择当前 Codex 对话、自动分配端口，并为每个来源对话单独保存房间。
--thread 指定来源对话。重启同一个房间时会恢复其协作分支。
可选环境变量为 TYPESAFE_API_KEY、GROUPTALK_CODEX_BIN 和 GROUPTALK_STATE_DIR。`);
  process.exit(0);
}
const cwd = resolve(values.cwd);
const sourceThreadId = values.thread ?? (values.share ? process.env.CODEX_THREAD_ID : undefined);
if (values.share && !sourceThreadId?.trim()) {
  console.error('找不到当前 Codex 对话 ID。请在要分享的本地 Codex 对话里使用 $grouptalk，或者传入 --thread <对话ID>。');
  process.exit(1);
}
const shareDirectory = values.share
  ? resolve(process.env.GROUPTALK_STATE_DIR || resolve(homedir(), '.grouptalk'), 'rooms', digest(sourceThreadId))
  : '.grouptalk';
const dataPath = resolve(values.data ?? shareDirectory);
const port = Number(values.port ?? (values.share ? '0' : '4317'));
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('端口不正确');
  process.exit(1);
}
const lockPath = resolve(dataPath, 'server.lock');
const certPath = values['tls-cert'], keyPath = values['tls-key'];
if (Boolean(certPath) !== Boolean(keyPath)) {
  console.error('请同时指定 TLS 证书和私钥。');
  process.exit(1);
}
function acquireLock() {
  mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('房间启动锁正在初始化，请稍后再试');
    try {
      process.kill(pid, 0);
    } catch (status) {
      if (status.code !== 'ESRCH') throw status;
      unlinkSync(lockPath);
      fd = openSync(lockPath, 'wx', 0o600);
    }
    if (fd === undefined) throw new Error(`此房间已由进程 ${pid} 运行，请使用该次启动的邀请链接`);
  }
  try { writeSync(fd, String(process.pid)); }
  finally { closeSync(fd); }
}
let store, room, web;
let ownsLock = false;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all([room?.close(), web?.close({ notifyStop: true })]);
  store?.close();
  if (ownsLock) {
    try { unlinkSync(lockPath); } catch {}
  }
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
try {
  acquireLock();
  ownsLock = true;
  store = new Store(resolve(dataPath, 'room.sqlite'));
  if (sourceThreadId && store.state.threadId && sourceThreadId !== store.state.sourceThreadId) {
    throw new Error('数据目录已绑定其他会话，请使用新的 --data 目录');
  }
  if (store.state.workspace && store.state.workspace !== cwd) {
    throw new Error('数据目录已绑定其他工作区，请从原工作区启动或使用新的 --data 目录');
  }
  store.state.workspace = cwd;
  store.save();
  const tls = certPath ? { cert: readFileSync(certPath), key: readFileSync(keyPath) } : undefined;
  const agent = new CodexAgent({ cwd, model: values.model });
  room = new Room({ store, agent, judge: new JevJudge(), cwd, sourceThreadId });
  console.log('正在连接本机 Codex，准备共享协作会话…');
  await room.initialize();
  web = await serve({ room, host: values.host, port, tls, onStop: () => stop() });
  const protocol = tls ? 'https' : 'http';
  const base = `${protocol}://127.0.0.1:${web.port}`;
  console.log(`\nGroupTalk 已启动\n工作区: ${cwd}\n来源线程: ${store.state.sourceThreadId || '新会话'}\n协作线程: ${store.state.threadId}\n`);
  console.log(`房主入口: ${base}/#host=${store.state.hostKey}`);
  console.log(`本机邀请: ${base}/#invite=${store.state.invite}`);
  for (const link of invitationLinks({ port: web.port, host: values.host, invite: store.state.invite, protocol })) {
    if (!link.localOnly) console.log(`局域网邀请 (${link.label}): ${link.url}`);
  }
  console.log(`\nJev: ${room.judge.ready ? '已配置，可在房间中开启' : '未配置，使用 @Codex 点名模式'}\nCtrl+C 停止服务；同一数据目录重启会保留房间和协作线程。`);
} catch (error) { console.error(`启动失败: ${error.message}`); await stop(1); }
