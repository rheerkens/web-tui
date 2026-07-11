#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createAuth } from '../src/auth.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverFile = path.join(packageRoot, 'server.js');
const appName = 'waypoint-terminal';
const serviceName = 'waypoint-terminal';
const configDir = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, appName)
  : path.join(os.homedir(), '.config', appName);
const stateDir = process.env.XDG_STATE_HOME
  ? path.join(process.env.XDG_STATE_HOME, appName)
  : path.join(os.homedir(), '.local', 'state', appName);
const configFile = path.join(configDir, 'config.json');
const stateFile = path.join(stateDir, 'daemon.json');
const logFile = path.join(stateDir, 'waypoint.log');
const authStateFile = path.join(stateDir, 'auth.json');

const HELP = `Waypoint Terminal — persistent AI-agent terminals in your browser

Usage:
  waypoint <command> [options]

Service commands:
  start                 Start in the background (or start the installed service)
  serve                 Run in the foreground
  stop                  Stop the background process or installed service
  restart               Restart Waypoint Terminal
  status [--json]       Show state and connection URL
  logs [-f|--follow]    Read service logs
  install-service       Install and start a per-user system service
  uninstall-service     Stop and remove the per-user system service
  auth                  Print a single-use five-minute login URL and code

Configuration and diagnostics:
  config                Print the saved configuration
  config set KEY VALUE  Set host, port, command, or tmux
  doctor [--json]       Check Node.js, tmux, the session command, and service state
  open                  Open the browser UI

Session automation:
  sessions [--json]          List tmux-backed sessions
  session create [NAME]      Create a session
  session delete NAME        End a session

Connection options accepted where relevant:
  --host HOST            Bind address (default: 0.0.0.0)
  --port PORT            HTTP port (default: 4173)
  --command COMMAND      Command launched in each new session (default: claude)
  --tmux PATH            tmux executable (default: tmux)
  --url URL              Public URL used by the auth command
  --json                 Machine-readable output where supported
  -h, --help             Show this help
  -v, --version          Show the package version

Examples:
  waypoint install-service --host 127.0.0.1 --port 4173
  waypoint status --json
  waypoint auth
  waypoint session create refactor-auth
  waypoint logs --follow

Automation contract:
  Commands exit 0 on success and non-zero on failure. Use --json with status,
  doctor, or sessions. The health endpoint is GET /api/health; session CRUD is
  GET/POST /api/sessions and DELETE /api/sessions/:name.
`;

function fail(message, code = 1) {
  console.error(`waypoint: ${message}`);
  process.exitCode = code;
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readConfig() {
  return { host: '0.0.0.0', port: 4173, command: 'claude', tmux: 'tmux', ...readJson(configFile) };
}

function saveConfig(config) {
  ensureDir(configDir);
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function parseOptions(values) {
  const options = {};
  const positionals = [];
  const aliases = { '-f': 'follow', '-h': 'help', '-v': 'version' };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (aliases[value]) { options[aliases[value]] = true; continue; }
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const [rawKey, inline] = value.slice(2).split(/=(.*)/s, 2);
    if (['json', 'follow', 'help', 'version'].includes(rawKey)) { options[rawKey] = true; continue; }
    const next = inline ?? values[++index];
    if (next === undefined || next.startsWith('--')) throw new Error(`--${rawKey} requires a value`);
    options[rawKey] = next;
  }
  return { options, positionals };
}

function applyOptions(config, options) {
  const next = { ...config };
  if (options.host !== undefined) next.host = options.host;
  if (options.port !== undefined) {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer from 1 to 65535');
    next.port = port;
  }
  if (options.command !== undefined) next.command = options.command;
  if (options.tmux !== undefined) next.tmux = options.tmux;
  return next;
}

function configEnvironment(config) {
  return {
    ...process.env,
    HOST: String(config.host),
    PORT: String(config.port),
    SESSION_COMMAND: String(config.command),
    TMUX_BIN: String(config.tmux),
    AUTH_STATE_FILE: authStateFile,
    PUBLIC_URL: urlFor(config)
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function daemonState() {
  const state = readJson(stateFile, null);
  if (state && processAlive(state.pid)) return state;
  if (state) fs.rmSync(stateFile, { force: true });
  return null;
}

function commandExists(command) {
  const result = spawnSync('sh', ['-lc', `command -v "$1" >/dev/null 2>&1`, 'sh', command], { stdio: 'ignore' });
  return result.status === 0;
}

function serviceFile() {
  if (process.platform === 'linux') {
    const home = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(home, 'systemd', 'user', `${serviceName}.service`);
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.waypoint.terminal.plist`);
  return null;
}

function hasService() {
  const file = serviceFile();
  return Boolean(file && fs.existsSync(file));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error((result.stderr || result.stdout || `${command} exited ${result.status}`).trim());
  }
  return result;
}

function serviceAction(action) {
  if (process.platform === 'linux') {
    const args = action === 'install'
      ? ['--user', 'enable', '--now', `${serviceName}.service`]
      : action === 'uninstall'
        ? ['--user', 'disable', '--now', `${serviceName}.service`]
        : ['--user', action, `${serviceName}.service`];
    return run('systemctl', args);
  }
  if (process.platform === 'darwin') {
    const domain = `gui/${process.getuid()}`;
    const label = 'com.waypoint.terminal';
    if (action === 'install') return run('launchctl', ['bootstrap', domain, serviceFile()]);
    if (action === 'uninstall' || action === 'stop') return run('launchctl', ['bootout', `${domain}/${label}`], { allowFailure: true });
    if (action === 'start' || action === 'restart') {
      const loaded = run('launchctl', ['print', `${domain}/${label}`], { allowFailure: true }).status === 0;
      return loaded
        ? run('launchctl', ['kickstart', '-k', `${domain}/${label}`])
        : run('launchctl', ['bootstrap', domain, serviceFile()]);
    }
  }
  throw new Error('service installation is supported on Linux (systemd) and macOS (launchd)');
}

function serviceRunning() {
  if (!hasService()) return false;
  if (process.platform === 'linux') return run('systemctl', ['--user', 'is-active', '--quiet', `${serviceName}.service`], { allowFailure: true }).status === 0;
  if (process.platform === 'darwin') return run('launchctl', ['print', `gui/${process.getuid()}/com.waypoint.terminal`], { allowFailure: true }).status === 0;
  return false;
}

function urlFor(config) {
  const host = ['0.0.0.0', '::', '::0'].includes(config.host) ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}

async function health(config) {
  try {
    const response = await fetch(`${urlFor(config)}/api/health`, { signal: AbortSignal.timeout(1200) });
    return response.ok ? response.json() : null;
  } catch { return null; }
}

async function waitForHealth(config, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await health(config);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function status(config) {
  const daemon = daemonState();
  const service = hasService();
  const reachable = await health(config);
  const externallyManaged = !service && !daemon && Boolean(reachable);
  return {
    running: service ? serviceRunning() : Boolean(daemon) || externallyManaged,
    reachable: Boolean(reachable),
    manager: service ? (process.platform === 'linux' ? 'systemd' : 'launchd') : daemon ? 'background' : externallyManaged ? 'external' : 'none',
    pid: daemon?.pid ?? null,
    url: urlFor(config),
    configFile,
    logFile: service && process.platform === 'linux' ? null : logFile
  };
}

async function start(config) {
  if (hasService()) {
    serviceAction('start');
  } else {
    const existing = daemonState();
    if (existing) return { alreadyRunning: true, pid: existing.pid };
    ensureDir(stateDir);
    const log = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [serverFile], {
      detached: true,
      stdio: ['ignore', log, log],
      env: configEnvironment(config)
    });
    child.unref();
    fs.closeSync(log);
    fs.writeFileSync(stateFile, `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);
  }
  const result = await waitForHealth(config);
  if (!result) throw new Error(`server did not become healthy; inspect logs with: waypoint logs`);
  return { alreadyRunning: false };
}

async function stop() {
  if (hasService()) {
    serviceAction('stop');
    return true;
  }
  const state = daemonState();
  if (!state) return false;
  process.kill(state.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 30 && processAlive(state.pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fs.rmSync(stateFile, { force: true });
  return true;
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function installService(config) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('service installation is supported on Linux and macOS');
  if (process.platform === 'linux' && !commandExists('systemctl')) throw new Error('systemd is not available; use `waypoint start` instead');
  await stop();
  saveConfig(config);
  const file = serviceFile();
  ensureDir(path.dirname(file));
  if (process.platform === 'linux') {
    const quote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    fs.writeFileSync(file, `[Unit]\nDescription=Waypoint Terminal\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} serve\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`);
    run('systemctl', ['--user', 'daemon-reload']);
  } else {
    ensureDir(stateDir);
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.waypoint.terminal</string>\n<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(fileURLToPath(import.meta.url))}</string><string>serve</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xml(logFile)}</string><key>StandardErrorPath</key><string>${xml(logFile)}</string>\n</dict></plist>\n`);
  }
  try {
    serviceAction('install');
  } catch (error) {
    fs.rmSync(file, { force: true });
    if (process.platform === 'linux') run('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
    throw error;
  }
  if (!await waitForHealth(config)) throw new Error('service was installed but did not become healthy; run `waypoint logs`');
}

async function uninstallService() {
  const file = serviceFile();
  if (!file || !fs.existsSync(file)) return false;
  serviceAction('uninstall');
  fs.rmSync(file, { force: true });
  if (process.platform === 'linux') run('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
  return true;
}

function printLogs(follow) {
  if (hasService() && process.platform === 'linux') {
    run('journalctl', ['--user', '-u', `${serviceName}.service`, ...(follow ? ['-f'] : ['-n', '100']), '--no-pager'], { stdio: 'inherit' });
    return;
  }
  ensureDir(stateDir);
  if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '');
  run('tail', [...(follow ? ['-f'] : ['-n', '100']), logFile], { stdio: 'inherit' });
}

async function api(config, pathname, options = {}) {
  let response;
  try {
    const authorization = `Bearer ${createAuth({ issuerOnly: true, stateFile: authStateFile }).createCliToken()}`;
    response = await fetch(`${urlFor(config)}${pathname}`, {
      headers: { 'content-type': 'application/json', authorization },
      signal: AbortSignal.timeout(5000),
      ...options
    });
  } catch {
    throw new Error('Waypoint Terminal is not reachable; start it with `waypoint start`');
  }
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `request failed (${response.status})`);
  return body;
}

async function main() {
  const [command = 'help', ...rawArgs] = process.argv.slice(2);
  const { options, positionals } = parseOptions(rawArgs);
  const packageInfo = readJson(path.join(packageRoot, 'package.json'));
  if (command === 'help' || options.help) { console.log(HELP); return; }
  if (command === '--version' || command === '-v' || options.version) { console.log(packageInfo.version); return; }

  let config = applyOptions(readConfig(), options);
  if (command === 'serve') {
    Object.assign(process.env, configEnvironment(config));
    await import('../server.js');
    return;
  }
  if (command === 'start') {
    if (hasService() && ['host', 'port', 'command', 'tmux'].some((key) => options[key] !== undefined)) saveConfig(config);
    const result = await start(config);
    console.log(result.alreadyRunning ? `Waypoint Terminal is already running (PID ${result.pid}).` : `Waypoint Terminal is running at ${urlFor(config)}`);
    return;
  }
  if (command === 'stop') { console.log(await stop() ? 'Waypoint Terminal stopped.' : 'Waypoint Terminal is not running.'); return; }
  if (command === 'restart') {
    if (hasService()) serviceAction('restart'); else { await stop(); await start(config); }
    if (!await waitForHealth(config)) throw new Error('server did not become healthy after restart');
    console.log(`Waypoint Terminal restarted at ${urlFor(config)}`);
    return;
  }
  if (command === 'status') {
    const result = await status(config);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.running && result.reachable ? 'running' : result.running ? 'starting/unreachable' : 'stopped'} (${result.manager})\nURL: ${result.url}\nConfig: ${result.configFile}${result.logFile ? `\nLog: ${result.logFile}` : ''}`);
    if (!result.running || !result.reachable) process.exitCode = 1;
    return;
  }
  if (command === 'logs') { printLogs(options.follow); return; }
  if (command === 'auth') {
    const publicUrl = options.url || urlFor(config);
    const parsed = new URL(publicUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('the public URL must use http:// or https://');
    const login = createAuth({ issuerOnly: true, stateFile: authStateFile }).createLoginCredentials(parsed.toString());
    console.log(`URL:  ${login.url}\nCode: ${login.code}`);
    return;
  }
  if (command === 'install-service') {
    await installService(config);
    console.log(`Installed and started the ${process.platform === 'linux' ? 'systemd user' : 'launchd user'} service.\nWaypoint Terminal is running at ${urlFor(config)}`);
    return;
  }
  if (command === 'uninstall-service') { console.log(await uninstallService() ? 'Waypoint Terminal service removed.' : 'No Waypoint Terminal service is installed.'); return; }
  if (command === 'config') {
    if (positionals[0] === 'set') {
      const [, key, ...valueParts] = positionals;
      if (!['host', 'port', 'command', 'tmux'].includes(key)) throw new Error('configuration key must be host, port, command, or tmux');
      if (!valueParts.length) throw new Error(`config set ${key} requires a value`);
      config = applyOptions(config, { [key]: valueParts.join(' ') });
      saveConfig(config);
      console.log(`Saved ${key} in ${configFile}. Restart Waypoint Terminal to apply it.`);
    } else console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (command === 'doctor') {
    const currentStatus = await status(config);
    const sessionExecutable = String(config.command).trim().split(/\s+/)[0];
    const checks = {
      node: { ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.version, required: '>=20' },
      tmux: { ok: commandExists(config.tmux), command: config.tmux },
      sessionCommand: { ok: commandExists(sessionExecutable), command: sessionExecutable },
      server: { ok: currentStatus.running && currentStatus.reachable, ...currentStatus }
    };
    checks.ok = checks.node.ok && checks.tmux.ok && checks.sessionCommand.ok;
    if (options.json) console.log(JSON.stringify(checks, null, 2));
    else for (const [name, check] of Object.entries(checks).filter(([name]) => name !== 'ok')) console.log(`${check.ok ? '✓' : '✗'} ${name}${check.command ? ` (${check.command})` : ''}${name === 'server' ? ` — ${check.url}` : ''}`);
    if (!checks.ok) process.exitCode = 1;
    return;
  }
  if (command === 'open') {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', urlFor(config)] : [urlFor(config)];
    run(opener, args, { stdio: 'ignore' });
    console.log(`Opened ${urlFor(config)}`);
    return;
  }
  if (command === 'sessions') {
    const result = await api(config, '/api/sessions');
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.sessions.length) console.log('No sessions.');
    else for (const session of result.sessions) console.log(`${session.name}\t${session.command}\t${session.attached ? 'attached' : 'detached'}`);
    return;
  }
  if (command === 'session') {
    const [action, name] = positionals;
    if (action === 'create') {
      const result = await api(config, '/api/sessions', { method: 'POST', body: JSON.stringify(name ? { name } : {}) });
      console.log(options.json ? JSON.stringify(result, null, 2) : `Created session ${result.name}.`);
      return;
    }
    if (action === 'delete' && name) {
      await api(config, `/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
      console.log(`Deleted session ${name}.`);
      return;
    }
    throw new Error('usage: waypoint session create [NAME] | waypoint session delete NAME');
  }
  throw new Error(`unknown command: ${command}\nRun 'waypoint help' for usage.`);
}

main().catch((error) => fail(error.message));
