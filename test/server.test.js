import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

process.env.NODE_ENV = 'test';
const { server } = await import('../server.js');

test.before(async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); });
test.after(() => server.close());

test('health endpoint reports server status', async () => {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('session list has a stable response shape', async () => {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).sessions));
});

test('invalid session names are rejected', async () => {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ name:'bad name!' }) });
  assert.equal(response.status, 400);
});
