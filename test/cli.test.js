import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../src/auth.js';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'bin', 'waypoint.js');

function run(args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

test('help describes service and machine-readable commands', () => {
  const output = run(['help']);
  assert.match(output, /install-service/);
  assert.match(output, /status \[--json\]/);
  assert.match(output, /Automation contract/);
});

test('version matches package metadata', () => {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(run(['--version']).trim(), packageInfo.version);
});

test('config is saved and read from an isolated XDG directory', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-cli-'));
  const env = { XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_STATE_HOME: path.join(temporary, 'state') };
  run(['config', 'set', 'port', '4317'], env);
  const config = JSON.parse(run(['config'], env));
  assert.equal(config.port, 4317);
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('unknown commands fail with an actionable message', () => {
  const result = spawnSync(process.execPath, [cli, 'not-a-command'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Run 'waypoint help'/);
});

test('auth prints a temporary URL and short code from the service state', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-cli-auth-'));
  const env = { XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_STATE_HOME: path.join(temporary, 'state') };
  const authFile = path.join(env.XDG_STATE_HOME, 'waypoint-terminal', 'auth.json');
  createAuth({ stateFile: authFile });
  const output = run(['auth', '--url', 'https://waypoint.test'], env);
  assert.match(output, /^URL:\s+https:\/\/waypoint\.test\/auth\/login\?token=/m);
  assert.match(output, /^Code: [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/m);
  fs.rmSync(temporary, { recursive: true, force: true });
});
