const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function commonCodexCandidates(homeDir = process.env.HOME || '') {
  return unique([
    homeDir ? path.join(homeDir, '.local/bin/codex') : '',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex'
  ]);
}

function buildRuntimePath(homeDir = process.env.HOME || '') {
  return unique([
    homeDir ? path.join(homeDir, '.local/bin') : '',
    '/Applications/Codex.app/Contents/Resources',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    process.env.PATH || ''
  ]).join(':');
}

function resolveCodexBin(configured = 'codex', homeDir = process.env.HOME || '') {
  const value = String(configured || '').trim() || 'codex';

  if (path.isAbsolute(value) || value.includes('/')) {
    const absolute = path.resolve(value);
    if (isExecutable(absolute)) return absolute;
    throw new Error(`Codex 命令不可执行或不存在：${absolute}`);
  }

  for (const candidate of commonCodexCandidates(homeDir)) {
    if (isExecutable(candidate)) return candidate;
  }

  try {
    const found = execFileSync('/usr/bin/env', ['which', value], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: buildRuntimePath(homeDir)
      }
    }).trim();
    if (found && isExecutable(found)) return found;
  } catch {
    // Fall through to the actionable error below.
  }

  throw new Error([
    `找不到 Codex 命令：${value}`,
    '请在设置里把 Codex 命令改成绝对路径，例如：',
    homeDir ? `${path.join(homeDir, '.local/bin/codex')}` : '/Users/你的用户名/.local/bin/codex',
    '或：/Applications/Codex.app/Contents/Resources/codex'
  ].join('\n'));
}

module.exports = {
  buildRuntimePath,
  commonCodexCandidates,
  isExecutable,
  resolveCodexBin
};
