import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { check, HttpError } from './validation.mjs';

const execute = promisify(execFile);
const MANAGED_LAYERS = ['mdm', 'enterpriseManaged', 'legacyManagedConfigTomlFromMdm'];

export async function commandRuleFiles(layers) {
  if (!Array.isArray(layers)) return null;
  const files = new Set();
  for (const layer of layers) {
    const { name, disabledReason } = layer || {};
    if (disabledReason) continue;
    if (!name || MANAGED_LAYERS.includes(name.type)) return null;
    if (name.type === 'sessionFlags') continue;
    const folder = name.dotCodexFolder || (name.file && dirname(name.file));
    if (!folder) return null;
    const rules = join(folder, 'rules');
    try {
      for (const file of await readdir(rules)) if (file.endsWith('.rules')) files.add(join(rules, file));
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
    }
  }
  return [...files];
}

function revision(value) {
  check(typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._/~^+-]{0,199}$/u.test(value), 400, '请输入 Git 分支、标签或提交 ID');
  return value;
}

export function gitInspectionCommand(input) {
  switch (input.operation) {
    case 'status':
      return ['git', 'status', '--short', '--branch', '--ignore-submodules=all'];
    case 'log':
      return ['git', 'log', '-12', '--no-show-signature', '--format=%h %s', '--end-of-options', revision(input.head), '--'];
    case 'diff':
      return ['git', 'diff', '--name-status', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all',
        '--end-of-options', revision(input.base), revision(input.head), '--'];
    default:
      throw new HttpError(400, '请选择工作区状态、提交记录或分支差异');
  }
}

export async function inspectGit({ rpc, cwd, command }) {
  const options = await rpc.request('config/read', { cwd, includeLayers: true });
  const rules = await commandRuleFiles(options?.layers);
  const { requirements } = await rpc.request('configRequirements/read');
  const compatible = requirements === null || (requirements && Object.entries(requirements).every(([key, value]) =>
    // Standalone command/exec does not log in or trigger Codex lifecycle hooks.
    value === null || (key === 'allowedLoginMethods' && Array.isArray(value)) ||
    (key === 'featureRequirements' && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).every((feature) => feature === 'hooks'))));
  check(rules && compatible, 403, '无法独立核对组织命令策略。请使用开房电脑上的原 Codex 对话检查 Git。');
  if (rules.length) {
    let policy;
    try {
      const args = rules.flatMap((path) => ['--rules', path]);
      const { stdout } = await execute(rpc.child.spawnfile, ['execpolicy', 'check', ...args, '--', ...command],
        { cwd, windowsHide: true, timeout: 5000, maxBuffer: 128_000 });
      policy = JSON.parse(stdout);
    } catch {
      throw new HttpError(403, '无法核对已保存的命令规则，Git 检查已停止。');
    }
    check(Array.isArray(policy?.matchedRules) && [undefined, 'allow', 'prompt'].includes(policy.decision), 403, '现有 Codex 命令规则禁止这项 Git 检查');
  }
  const env = {
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_PARAMETERS: null, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
    GIT_DIR: null, GIT_WORK_TREE: null, GIT_COMMON_DIR: null, GIT_INDEX_FILE: null,
  };
  const result = await rpc.request('command/exec', {
    command, cwd, env, timeoutMs: 10_000, sandboxPolicy: { type: 'readOnly', networkAccess: false },
  }, 15_000);
  check(result.exitCode === 0, 422, (result.stderr || 'Git 检查失败。请检查工作区和本地分支引用。').trim().slice(0, 500));
  const output = (result.stdout || '').trim();
  return { text: output.slice(0, 10_000), truncated: output.length > 10_000 };
}
