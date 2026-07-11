import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../src/auth.js';

process.env.NODE_ENV = 'test';
const { server, auth } = await import('../server.js');

const base = () => `http://127.0.0.1:${server.address().port}`;

async function login() {
  const link = auth.createLoginLink(base());
  const response = await fetch(link, { redirect: 'manual' });
  assert.equal(response.status, 303);
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}

test.before(async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); });
test.after(() => server.close());

test('health endpoint reports server status', async () => {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('session list has a stable response shape', async () => {
  const response = await fetch(`${base()}/api/sessions`, { headers: { cookie: await login() } });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).sessions));
});

test('invalid session names are rejected', async () => {
  const response = await fetch(`${base()}/api/sessions`, { method:'POST', headers:{'content-type':'application/json', cookie: await login()}, body:JSON.stringify({ name:'bad name!' }) });
  assert.equal(response.status, 400);
});

test('protected routes reject unauthenticated requests', async () => {
  const response = await fetch(`${base()}/api/sessions`);
  assert.equal(response.status, 401);
});

test('a short-lived local CLI bearer token can access protected APIs', async () => {
  const response = await fetch(`${base()}/api/sessions`, {
    headers: { authorization: `Bearer ${auth.createCliToken()}` }
  });
  assert.equal(response.status, 200);
});

test('temporary login links are single-use and set protected cookies', async () => {
  const link = auth.createLoginLink(base());
  const first = await fetch(link, { redirect: 'manual' });
  assert.equal(first.status, 303);
  const cookies = first.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every((value) => value.includes('HttpOnly') && value.includes('SameSite=Strict')));
  const second = await fetch(link, { redirect: 'manual' });
  assert.equal(second.status, 401);
});

test('logout revokes a refresh session', async () => {
  const cookies = await login();
  const logout = await fetch(`${base()}/auth/logout`, { method: 'POST', headers: { cookie: cookies } });
  assert.equal(logout.status, 204);
  const response = await fetch(`${base()}/api/sessions`, { headers: { cookie: cookies } });
  assert.equal(response.status, 401);
});

test('a refresh cookie automatically rotates and restores access', async () => {
  const cookies = await login();
  const refresh = cookies.split('; ').find((value) => value.startsWith('waypoint_refresh='));
  const response = await fetch(`${base()}/api/sessions`, { headers: { cookie: refresh } });
  assert.equal(response.status, 200);
  const rotated = response.headers.getSetCookie();
  assert.equal(rotated.length, 2);
  assert.ok(rotated.some((value) => value.startsWith('waypoint_access=')));
  assert.ok(rotated.some((value) => value.startsWith('waypoint_refresh=')));
});

test('WebSocket upgrades require an authenticated browser', async () => {
  const address = `ws://127.0.0.1:${server.address().port}/ws?session=missing`;
  const unauthorized = new WebSocket(address);
  const [error] = await once(unauthorized, 'error');
  assert.match(error.message, /401/);

  const authorized = new WebSocket(address, { headers: { cookie: await login() } });
  await once(authorized, 'open');
  const [code] = await once(authorized, 'close');
  assert.equal(code, 1008);
});

test('CLI-generated short codes are accepted once by an already-running auth instance', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-auth-test-'));
  const stateFile = path.join(directory, 'auth.json');
  try {
    const runningAuth = createAuth({ stateFile });
    const output = execFileSync(process.execPath, ['bin/waypoint-auth.js', '--url', 'https://waypoint.test'], {
      cwd: path.resolve('.'),
      env: { ...process.env, NODE_ENV: 'production', AUTH_STATE_FILE: stateFile },
      encoding: 'utf8'
    }).trim();
    const lines = output.split('\n');
    const link = lines.find((line) => line.startsWith('URL:')).replace(/^URL:\s*/, '');
    const code = lines.find((line) => line.startsWith('Code:')).replace(/^Code:\s*/, '');
    assert.match(link, /^https:\/\/waypoint\.test\/auth\/login\?token=/);
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const token = new URL(link).searchParams.get('token');
    const request = { query: { token }, headers: {}, socket: {}, secure: false };
    const makeResponse = () => {
      const result = { statusCode: 200, redirected: null };
      result.setHeader = () => {};
      result.status = (code) => { result.statusCode = code; return result; };
      result.type = () => result;
      result.send = () => result;
      result.redirect = (code, location) => { result.statusCode = code; result.redirected = location; };
      return result;
    };
    const first = makeResponse();
    runningAuth.loginWithCode({ body: { code: code.toLowerCase() }, ip: '127.0.0.1', headers: {}, socket: {}, secure: false }, first);
    assert.equal(first.statusCode, 303);
    assert.equal(first.redirected, '/');

    const second = makeResponse();
    runningAuth.login(request, second);
    assert.equal(second.statusCode, 401);

    const restartedAuth = createAuth({ stateFile });
    const afterRestart = makeResponse();
    restartedAuth.login(request, afterRestart);
    assert.equal(afterRestart.statusCode, 401);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
