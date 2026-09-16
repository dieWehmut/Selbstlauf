import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WatchdogEngine } from '../src/engine/watchdog.js';

test('does not inject while output is recent', () => {
  const engine = new WatchdogEngine({ idleTimeoutMs: 100, cooldownMs: 500 });

  engine.observeOutput('s1', 1_000);

  assert.deepEqual(engine.tick(1_050), []);
});

test('injects once after quiet time and waits for new output', () => {
  const engine = new WatchdogEngine({ idleTimeoutMs: 100, cooldownMs: 500 });

  engine.observeOutput('s1', 1_000);

  const first = engine.tick(1_101);
  assert.deepEqual(first.map((intent) => intent.sessionId), ['s1']);
  assert.deepEqual(engine.tick(1_202), []);

  engine.observeOutput('s1', 1_250);
  assert.deepEqual(engine.tick(1_351).map((intent) => intent.sessionId), ['s1']);
});

test('does not inject paused, disabled, or exited sessions', () => {
  const engine = new WatchdogEngine({ idleTimeoutMs: 100, cooldownMs: 500 });

  engine.observeOutput('paused', 1_000);
  engine.pause('paused');
  assert.deepEqual(engine.tick(1_101), []);
  engine.resume('paused');
  assert.deepEqual(engine.tick(1_101).map((intent) => intent.sessionId), ['paused']);

  engine.observeOutput('disabled', 1_000);
  engine.setEnabled('disabled', false);
  assert.deepEqual(engine.tick(1_101), []);

  engine.observeOutput('exited', 1_000);
  engine.markExited('exited');
  assert.deepEqual(engine.tick(1_101), []);
});

test('fails closed on a clock rollback', () => {
  const engine = new WatchdogEngine({ idleTimeoutMs: 100, cooldownMs: 500 });

  engine.observeOutput('s1', 1_000);
  assert.deepEqual(engine.tick(900), []);
  assert.equal(engine.getState('s1')?.lastDecision, 'clock-rollback');
  assert.deepEqual(engine.tick(1_050), []);
});

test('starts cooldown after success and output resets cooldown and attempts', () => {
  const engine = new WatchdogEngine({
    idleTimeoutMs: 100,
    cooldownMs: 500,
    maxAttemptsPerQuietPeriod: 2,
  });

  engine.observeOutput('s1', 1_000);
  assert.equal(engine.tick(1_101).length, 1);
  engine.recordInjectionSuccess('s1', 1_101);

  assert.deepEqual(engine.tick(1_600), []);
  assert.equal(engine.tick(1_601).length, 1);

  engine.observeOutput('s1', 1_650);
  assert.equal(engine.getState('s1')?.attempts, 0);
  assert.equal(engine.getState('s1')?.lastInjectionAt, null);
  assert.equal(engine.tick(1_751).length, 1);
});

test('transport failure leaves the attempt uncommitted until retry time', () => {
  const engine = new WatchdogEngine({ idleTimeoutMs: 100, cooldownMs: 500 });

  engine.observeOutput('s1', 1_000);
  assert.equal(engine.tick(1_101).length, 1);
  engine.recordTransportError('s1', 1_101);

  const state = engine.getState('s1');
  assert.equal(state?.attempts, 0);
  assert.equal(state?.pending, false);
  assert.equal(state?.retryAfterAt, 1_601);
  assert.deepEqual(engine.tick(1_600), []);
  assert.equal(engine.tick(1_601).length, 1);
});

test('does not exceed the configured attempts in one quiet period', () => {
  const engine = new WatchdogEngine({
    idleTimeoutMs: 100,
    cooldownMs: 100,
    maxAttemptsPerQuietPeriod: 2,
  });

  engine.observeOutput('s1', 1_000);
  assert.equal(engine.tick(1_101).length, 1);
  engine.recordInjectionSuccess('s1', 1_101);
  assert.equal(engine.tick(1_201).length, 1);
  engine.recordInjectionSuccess('s1', 1_201);
  assert.deepEqual(engine.tick(9_999), []);
  assert.equal(engine.getState('s1')?.lastDecision, 'max-attempts');
});

test('returns frozen injection intents and frozen state snapshots', () => {
  const engine = new WatchdogEngine({ idleTimeoutMs: 100, cooldownMs: 500 });

  engine.observeOutput('s1', 1_000);
  const intents = engine.tick(1_101);

  assert.equal(Object.isFrozen(intents), true);
  assert.equal(Object.isFrozen(intents[0]), true);
  assert.equal(Object.isFrozen(engine.getState('s1')), true);
});
