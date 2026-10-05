// The Host check `preview` and `view` share: a request is answered only when it names the
// server the way the server prints it, so a DNS-rebinding page can't read either one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost } from '../lib/loopback-host.mjs';

test('the printed names pass, in any case, and only with the right port', () => {
  for (const h of ['127.0.0.1:5173', 'localhost:5173', 'LOCALHOST:5173']) assert.equal(isLoopbackHost(h, 5173), true, h);
  for (const h of ['127.0.0.1:5174', '127.0.0.1', 'localhost', 'attacker.example:5173', '127.0.0.1.example:5173', 'localhost.example:5173', '[::1]:5173', '', undefined, null]) {
    assert.equal(isLoopbackHost(h, 5173), false, String(h));
  }
});

test('on port 80 a browser leaves the port out, so the bare name passes there and only there', () => {
  for (const h of ['127.0.0.1', 'localhost', '127.0.0.1:80', 'localhost:80']) assert.equal(isLoopbackHost(h, 80), true, h);
  assert.equal(isLoopbackHost('attacker.example', 80), false);
  assert.equal(isLoopbackHost('127.0.0.1', 8080), false);
});

test('a server bound to another loopback name answers only that name', () => {
  assert.equal(isLoopbackHost('localhost:4000', 4000, 'localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1:4000', 4000, 'localhost'), false);
});
