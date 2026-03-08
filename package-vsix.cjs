const { spawnSync } = require('child_process');
const { readFileSync } = require('fs');
const path = require('path');

const repoRoot = __dirname;
const packageJsonPath = path.join(repoRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

if (typeof version !== 'string' || version.trim() === '') {
  console.error('Unable to determine extension version from package.json');
  process.exit(1);
}

const outputFile = `codex-ratelimit-${version}.vsix`;
const npmCliPath = process.env.npm_execpath;

if (typeof npmCliPath !== 'string' || npmCliPath.trim() === '') {
  console.error('Unable to determine npm executable path from npm_execpath');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [npmCliPath, 'exec', '--yes', '@vscode/vsce', 'package', '--', '--out', outputFile],
  {
    cwd: repoRoot,
    stdio: 'inherit'
  }
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
