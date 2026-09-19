import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import extension, { parseModelSpec } from '../index.ts';
import { isolateConfig } from './isolated-config.mjs';

const dir = isolateConfig();
const config = join(dir, 'pi-tab-title.json');
const session = { provider: 'session', id: 'large', reasoning: true };
const custom = { provider: 'local', id: 'org/small', reasoning: false };
const other = { provider: 'other', id: 'mid', reasoning: false };
const tick = () => new Promise(resolve => setImmediate(resolve));
const answer = () => ({ stopReason: 'stop', content: [{ type: 'text', text: '测试模型选择' }] });
const preference = () => JSON.parse(readFileSync(config, 'utf8'));
beforeEach(() => rmSync(config, { recursive: true, force: true }));

function harness(t, { available = [session, custom, other], mode = 'tui', select, complete } = {}) {
  const hooks = {}, commands = {}, entries = [], calls = [], notices = [], selections = [], titles = [];
  let name;
  const ctx = {
    mode, model: session, isIdle: () => true,
    modelRegistry: {
      getAvailable: () => available,
      find: (provider, id) => available.find(model => model.provider === provider && model.id === id),
      complete: (...args) => { calls.push(args); return complete ? complete(...args) : Promise.resolve(answer()); },
    },
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    ui: {
      notify: (...args) => notices.push(args), setTitle: title => titles.push(title),
      select: async (title, choices) => { selections.push({ title, choices }); return select ? select(choices) : undefined; },
    },
  };
  const emit = async (event, data = {}) => { for (const fn of hooks[event] ?? []) await fn(data, ctx); };
  extension({
    on: (event, fn) => (hooks[event] ??= []).push(fn),
    registerCommand: (name, spec) => commands[name] = spec,
    registerTool() {},
    getSessionName: () => name,
    setSessionName: value => { name = value; void emit('session_info_changed', { name }); },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  });
  t.after(() => emit('session_shutdown'));
  return {
    ctx, calls, notices, entries, selections, titles, emit,
    start: () => emit('session_start'),
    choose: args => commands.tabmodel.handler(args, ctx),
    manual: title => commands.tabname.handler(title, ctx),
    async prompt() {
      entries.push({ type: 'message', message: { role: 'user', content: '合成命名测试' } });
      await emit('before_agent_start', { prompt: '合成命名测试' }); await tick();
    },
    async retry() { await commands.tabname.handler('auto', ctx); await tick(); },
  };
}

test('model specs retain slash-containing IDs and reject missing/control/whitespace components', () => {
  assert.deepEqual(parseModelSpec('openrouter/vendor/model'), { provider: 'openrouter', model: 'vendor/model' });
  for (const text of ['model', '/model', 'provider/', 'a/ b', 'a/b\u001b', 'a/b\u202e']) assert.equal(parseModelSpec(text), undefined);
});

test('without a preference the session model is used and no config file is written', async t => {
  const h = harness(t); await h.start(); await h.prompt();
  assert.equal(h.calls[0][0], session);
  assert.deepEqual(readdirSync(dir), []);
});

test('an explicit choice persists, makes no request, and overrides the session model', async t => {
  const h = harness(t); await h.start(); await h.choose('local/org/small');
  assert.deepEqual(preference(), { version: 1, provider: 'local', model: 'org/small' });
  assert.deepEqual(readdirSync(dir), ['pi-tab-title.json']);
  assert.equal(h.calls.length, 0); assert.equal(h.ctx.model, session);
  h.ctx.model = other;
  await h.prompt(); assert.equal(h.calls[0][0], custom);
  assert.equal(h.calls[0][2].reasoningEffort, undefined);
});

test('picker lists available model IDs, persists selected model and cancellation preserves preference', async t => {
  const h = harness(t, { select: choices => choices.find(choice => choice === 'local/org/small') });
  await h.start(); await h.choose('');
  assert.deepEqual(h.selections[0].choices, ['local/org/small', 'other/mid', 'session/large']);
  assert.equal(preference().provider, 'local');
  const cancelled = harness(t); await cancelled.start(); await cancelled.choose('');
  assert.equal(preference().provider, 'local'); assert.equal(cancelled.calls.length, 0);
});

test('current pins the current model rather than following later main model changes', async t => {
  const h = harness(t); await h.start(); await h.choose('current');
  h.ctx.model = custom;
  await h.prompt(); assert.equal(h.calls[0][0], session); assert.equal(h.ctx.model, custom);
});

test('show is read-only; reset clears the preference and returns to the session model', async t => {
  const h = harness(t); await h.start(); await h.choose('local/org/small'); await h.choose('show');
  assert.ok(h.notices.at(-1)[0].includes('local/org/small'));
  assert.equal(preference().provider, 'local'); assert.equal(h.calls.length, 0);
  await h.choose('reset');
  assert.deepEqual(readdirSync(dir), []);
  h.ctx.model = other;
  await h.prompt(); assert.equal(h.calls[0][0], other);
  await h.choose('show');
  assert.ok(h.notices.at(-1)[0].includes('跟随当前会话模型'));
});

test('invalid, unknown and unavailable choices do not overwrite valid preference', async t => {
  const h = harness(t); await h.start(); await h.choose('local/org/small');
  for (const value of ['malformed', 'missing/model', '/model']) {
    await h.choose(value); assert.equal(preference().provider, 'local');
  }
  const noAuth = harness(t, { available: [] }); await noAuth.start();
  await noAuth.choose(''); await noAuth.choose('missing/model');
  assert.equal(preference().provider, 'local'); assert.equal(noAuth.selections.length, 0);
  assert.equal(noAuth.calls.length, 0);
});

test('persisted choice survives a new runtime and reload', async t => {
  const a = harness(t); await a.start(); await a.choose('local/org/small');
  await a.emit('session_shutdown');
  const b = harness(t); await b.start(); await b.prompt();
  assert.equal(b.calls[0][0], custom);
  await b.emit('session_start', { reason: 'reload' }); await b.retry();
  assert.equal(b.calls[1][0], custom);
});

test('existing tabs read another tab\'s new choice on their next naming request', async t => {
  const a = harness(t), b = harness(t); await a.start(); await b.start();
  await a.prompt(); assert.equal(a.calls[0][0], session);
  await b.choose('local/org/small'); await a.retry();
  assert.equal(a.calls[1][0], custom);
});

test('malformed config fails closed without model fallback, and explicit selection repairs it', async t => {
  writeFileSync(config, '{broken');
  const h = harness(t); await h.start(); await h.prompt();
  assert.equal(h.calls.length, 0);
  assert.equal(h.entries.at(-1).data.status, 'failed');
  await h.choose('local/org/small'); await h.retry(); assert.equal(h.calls[0][0], custom);
});

test('invalid config fields are rejected without implicit fallback', async t => {
  for (const data of [null, [], { version: 2 }, { version: 1, provider: '', model: 'x' },
    { version: 1, provider: 'a/b', model: 'x' }, { version: 1, provider: 'local', model: 'x\u001b' }]) {
    writeFileSync(config, JSON.stringify(data));
    const h = harness(t); await h.start(); await h.prompt(); assert.equal(h.calls.length, 0);
  }
});

test('missing configured model never falls back to the session model', async t => {
  writeFileSync(config, JSON.stringify({ version: 1, provider: 'missing', model: 'model' }));
  const h = harness(t); await h.start(); await h.prompt();
  assert.equal(h.calls.length, 0); assert.equal(h.entries.at(-1).data.status, 'failed');
});

test('switch during naming aborts old request, ignores late result, and requires explicit retry', async t => {
  let resolve;
  const h = harness(t, { complete: () => new Promise(r => resolve = r) });
  await h.start(); await h.prompt();
  const signal = h.calls[0][2].signal;
  await h.choose('local/org/small');
  assert.equal(signal.aborted, true); assert.equal(h.entries.at(-1).data.status, 'skipped');
  resolve(answer()); await tick(); assert.deepEqual(h.titles, []);
  assert.equal(h.calls.length, 1);
  await h.retry(); assert.equal(h.calls[1][0], custom);
  resolve(answer()); await tick(); assert.equal(h.titles.at(-1), '测试模型选择');
});

test('picker cancellation does not cancel active naming request', async t => {
  let resolve;
  const h = harness(t, { complete: () => new Promise(r => resolve = r) });
  await h.start(); await h.prompt(); await h.choose('');
  assert.equal(h.calls[0][2].signal.aborted, false);
  resolve(answer()); await tick(); assert.equal(h.titles.at(-1), '测试模型选择');
});

test('save failure leaves active naming request intact and cleans the temporary config', async t => {
  let resolve;
  const h = harness(t, { complete: () => new Promise(r => resolve = r) });
  await h.start(); await h.prompt();
  mkdirSync(config);
  await h.choose('local/org/small');
  assert.equal(h.calls[0][2].signal.aborted, false);
  assert.deepEqual(readdirSync(dir), ['pi-tab-title.json']);
  assert.ok(h.notices.at(-1)[0].includes('保存失败'));
  resolve(answer()); await tick(); assert.equal(h.titles.at(-1), '测试模型选择');
});

test('reset during naming aborts the in-flight request and ignores its late result', async t => {
  let resolve;
  const h = harness(t, { complete: () => new Promise(r => resolve = r) });
  await h.start(); await h.prompt();
  const signal = h.calls[0][2].signal;
  await h.choose('reset');
  assert.equal(signal.aborted, true); assert.equal(h.entries.at(-1).data.status, 'skipped');
  resolve(answer()); await tick(); assert.deepEqual(h.titles, []);
  assert.equal(h.calls.length, 1);
});

test('closed runtime cannot save a late picker selection', async t => {
  let resolve;
  const h = harness(t, { select: () => new Promise(r => resolve = r) });
  await h.start(); const pending = h.choose('');
  await h.emit('session_shutdown'); resolve('local/org/small'); await pending;
  assert.deepEqual(readdirSync(dir), []);
});

test('later model command takes precedence over an earlier open picker', async t => {
  let resolve;
  const h = harness(t, { select: () => new Promise(r => resolve = r) });
  await h.start(); const pending = h.choose('');
  await h.choose('other/mid'); resolve('local/org/small'); await pending;
  assert.equal(preference().provider, 'other');
});

test('changing preference never re-arms automatic naming after manual rename', async t => {
  const h = harness(t); await h.start(); await h.manual('手动名称优先');
  await h.choose('local/org/small'); await h.prompt();
  assert.equal(h.calls.length, 0); assert.equal(h.titles.at(-1), '手动名称优先');
});

test('non-TUI model commands do not read/write config, show picker, or request a model', async t => {
  for (const mode of ['print', 'json', 'rpc']) {
    const h = harness(t, { mode }); await h.start();
    for (const args of ['', 'show', 'current', 'reset', 'local/org/small']) await h.choose(args);
    assert.deepEqual(h.notices, []); assert.deepEqual(h.selections, []); assert.deepEqual(h.calls, []);
    assert.deepEqual(readdirSync(dir), []);
  }
});
