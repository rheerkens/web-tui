import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';

const exec = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const tmux = process.env.TMUX_BIN || 'tmux';
const defaultCommand = process.env.SESSION_COMMAND || 'claude';
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export async function listSessions() {
  try {
    const { stdout } = await exec(tmux, [
      'list-sessions', '-F',
      '#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{pane_current_command}'
    ]);
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [name, attached, windows, created, command] = line.split('\t');
      return {
        name,
        attached: Number(attached),
        windows: Number(windows),
        created: Number(created) * 1000,
        command
      };
    });
  } catch (error) {
    if (error.stderr?.includes('no server running') || error.stderr?.includes('no sessions') || error.stderr?.includes('error connecting to')) return [];
    throw error;
  }
}

async function createSession(requestedName) {
  const suffix = Math.random().toString(36).slice(2, 6);
  const name = requestedName || `claude-${new Date().toISOString().slice(11, 16).replace(':', '')}-${suffix}`;
  if (!NAME.test(name)) throw Object.assign(new Error('Use letters, numbers, dots, dashes, or underscores.'), { status: 400 });
  const existing = await listSessions();
  if (existing.some((session) => session.name === name)) throw Object.assign(new Error('A session with that name already exists.'), { status: 409 });
  await exec(tmux, ['new-session', '-d', '-s', name, '-c', process.env.HOME || os.homedir(), defaultCommand]);
  return name;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, host: os.hostname(), command: defaultCommand }));
app.get('/api/sessions', async (_req, res, next) => {
  try { res.json({ sessions: await listSessions() }); } catch (error) { next(error); }
});
app.post('/api/sessions', async (req, res, next) => {
  try { res.status(201).json({ name: await createSession(req.body?.name?.trim()) }); } catch (error) { next(error); }
});
app.delete('/api/sessions/:name', async (req, res, next) => {
  try {
    if (!NAME.test(req.params.name)) throw Object.assign(new Error('Invalid session name.'), { status: 400 });
    await exec(tmux, ['kill-session', '-t', `=${req.params.name}`]);
    res.status(204).end();
  } catch (error) { next(error); }
});
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
app.use((error, _req, res, _next) => {
  if (!error.status || error.status >= 500) console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Unexpected server error' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws' || !NAME.test(url.searchParams.get('session') || '')) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  request.sessionName = url.searchParams.get('session');
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

wss.on('connection', async (ws, request) => {
  const name = request.sessionName;
  if (!(await listSessions()).some((session) => session.name === name)) {
    ws.close(1008, 'Session not found');
    return;
  }
  const terminal = pty.spawn(tmux, ['attach-session', '-t', `=${name}`], {
    name: 'xterm-256color', cols: 100, rows: 30,
    cwd: process.env.HOME || os.homedir(), env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  });
  terminal.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
  });
  terminal.onExit(({ exitCode }) => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, `Terminal exited (${exitCode})`);
  });
  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'input' && typeof message.data === 'string') terminal.write(message.data);
      if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        terminal.resize(Math.max(10, Math.min(500, message.cols)), Math.max(4, Math.min(300, message.rows)));
      }
    } catch { /* Ignore malformed client messages. */ }
  });
  ws.on('close', () => terminal.kill());
  ws.on('error', () => terminal.kill());
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, host, () => console.log(`Waypoint Terminal listening on http://${host}:${port}`));

  const shutdown = () => {
    wss.clients.forEach((client) => client.close(1001, 'Server shutting down'));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export { app, server };
