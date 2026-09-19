import assert from 'node:assert/strict';
import { test } from 'node:test';
import extension from '../index.ts';
import { isolateConfig } from './isolated-config.mjs';
isolateConfig();

function harness(t, { name = '标签状态增强', mode = 'tui', complete } = {}) {
  const hooks = new Map(), commands = {}, titles = [], entries = [], calls = [];
  let idle = true, currentName = name;
  let abort = new AbortController();
  const ctx = {
    mode, isIdle: () => idle, model: { id: 'session-model', provider: 'example', reasoning: false },
    get signal() { return abort.signal; },
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    ui: { setTitle: title => titles.push(title), notify() {}, confirm: async () => true },
    modelRegistry: {
      find: () => ({ id: 'small-model', provider: 'example', reasoning: false }),
      complete: (...args) => { calls.push(args); return complete(...args); },
    },
  };
  const emit = async (name, event = {}) => {
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  };
  extension({
    on(name, handler) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
    registerCommand(name, command) { commands[name] = command; },
    registerTool() {},
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    getSessionName: () => currentName,
    setSessionName(name) { currentName = name; void emit('session_info_changed', { name }); },
  });
  t.after(() => emit('session_shutdown'));
  return {
    emit, ctx, titles, entries, calls, commands,
    title: () => titles.at(-1), name: () => currentName,
    async start() { await emit('session_start'); },
    async run() { idle = false; abort = new AbortController(); await emit('agent_start'); },
    async message(stopReason = 'stop') {
      await emit('message_end', { message: { role: 'assistant', content: [], stopReason } });
    },
    async settle() { idle = true; await emit('agent_settled'); },
    cancel() { abort.abort(); },
  };
}
const isRunning = title => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u.test(title);
const enableClock = t => t.mock.timers.enable({ apis: ['setInterval'] });

test('three icons: animation, failure, completion; name and entries never contain runtime icons', async t => {
  enableClock(t);
  const h = harness(t); await h.start();
  assert.equal(h.title(), '标签状态增强');
  await h.run(); assert.equal(h.title(), '⠋ 标签状态增强');
  t.mock.timers.tick(200); assert.equal(h.title(), '⠙ 标签状态增强');
  await h.message(); await h.settle(); assert.equal(h.title(), '· 标签状态增强');
  const count = h.titles.length;
  t.mock.timers.tick(2000); assert.equal(h.titles.length, count);
  await h.run(); await h.message('error'); await h.settle();
  assert.equal(h.title(), '× 标签状态增强');
  assert.equal(h.name(), '标签状态增强');
  assert.equal(h.entries.length, 1);
  assert.ok(!JSON.stringify(h.entries).match(/[·×⠋⠙]/u));
  assert.equal(h.calls.length, 0);
});

test('agent_end does not finish the run; retry success clears the previous error', async t => {
  enableClock(t);
  const h = harness(t); await h.start(); await h.run();
  await h.message('error'); await h.emit('agent_end');
  t.mock.timers.tick(600); assert.ok(isRunning(h.title()));
  await h.run(); await h.message(); await h.settle();
  assert.equal(h.title(), '· 标签状态增强');
});

test('queued follow-up and non-idle settled event cannot briefly show completion', async t => {
  const h = harness(t); await h.start(); await h.run(); await h.message();
  await h.emit('agent_end'); await h.emit('agent_settled');
  assert.ok(isRunning(h.title()));
  await h.run(); await h.message(); await h.settle();
  assert.equal(h.title(), '· 标签状态增强');
});

test('recoverable tool failure is not a failed task', async t => {
  const h = harness(t); await h.start(); await h.run(); await h.message('toolUse');
  await h.emit('tool_execution_end', { isError: true });
  assert.ok(isRunning(h.title()));
  await h.message(); await h.settle(); assert.equal(h.title(), '· 标签状态增强');
});

test('terminated failed tool batch shows error, successful terminating batch shows done', async t => {
  for (const isError of [true, false]) {
    const h = harness(t); await h.start(); await h.run(); await h.message('toolUse');
    await h.emit('tool_execution_end', { isError });
    await h.settle(); assert.equal(h.title(), `${isError ? '×' : '·'} 标签状态增强`);
  }
});

test('aborted assistant and cancellation during a tool batch leave bare title', async t => {
  enableClock(t);
  for (const stop of ['aborted', 'toolUse']) {
    const h = harness(t); await h.start(); await h.run(); await h.message(stop);
    if (stop === 'toolUse') h.cancel();
    await h.settle(); assert.equal(h.title(), '标签状态增强');
    const count = h.titles.length;
    t.mock.timers.tick(1000); assert.equal(h.titles.length, count);
  }
});

test('truncated or absent final answer is not marked complete', async t => {
  for (const stop of ['length', undefined]) {
    const h = harness(t); await h.start(); await h.run();
    if (stop) await h.message(stop);
    await h.settle(); assert.equal(h.title(), '× 标签状态增强');
  }
});

test('automatic compaction runs until settled; failure and cancellation are distinguished', async t => {
  for (const aborted of [true, false]) {
    const h = harness(t); await h.start(); await h.run(); await h.message();
    await h.emit('session_before_compact', { reason: 'threshold' });
    assert.ok(isRunning(h.title()));
    await h.emit('session_compact_failed', { reason: 'threshold', aborted });
    await h.settle(); assert.equal(h.title(), `${aborted ? '' : '× '}标签状态增强`);
  }
});

test('compaction recovery followed by a successful run clears prior failure', async t => {
  const h = harness(t); await h.start(); await h.run(); await h.message('error');
  await h.emit('session_compact_failed', { reason: 'overflow', aborted: false });
  await h.run(); await h.message(); await h.settle();
  assert.equal(h.title(), '· 标签状态增强');
});

test('renaming while running and after completion preserves current icon', async t => {
  enableClock(t);
  const h = harness(t); await h.start(); await h.run();
  await h.commands.tabname.handler('手动名称', h.ctx);
  assert.equal(h.title(), '⠋ 手动名称'); assert.equal(h.name(), '手动名称');
  t.mock.timers.tick(200); assert.equal(h.title(), '⠙ 手动名称');
  await h.message(); await h.settle();
  await h.emit('session_info_changed', { name: '内置改名' });
  assert.equal(h.title(), '· 内置改名');
});

test('late automatic naming response keeps both running and completed icons', async t => {
  for (const finishFirst of [true, false]) {
    let resolve;
    const h = harness(t, { name: null, complete: () => new Promise(r => resolve = r) });
    await h.start();
    await h.emit('before_agent_start', { prompt: '合成命名输入' });
    await h.run();
    if (finishFirst) { await h.message(); await h.settle(); }
    resolve({ stopReason: 'stop', content: [{ type: 'text', text: '自动生成名称' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.title(), `${finishFirst ? '·' : '⠋'} 自动生成名称`);
    assert.equal(h.name(), '自动生成名称');
    assert.equal(h.calls.length, 1);
  }
});

test('naming failure cannot turn a successful task into a failure', async t => {
  const h = harness(t, { complete: async () => { throw Error('synthetic failure'); } });
  await h.start();
  h.ctx.sessionManager.getBranch = () => [{ type: 'message', message: { role: 'user', content: '合成输入' } }];
  await h.run(); await h.commands.tabname.handler('auto', h.ctx);
  await h.message(); await h.settle();
  assert.equal(h.title(), '· 标签状态增强');
});

test('reload, tree navigation and shutdown stop old animations; no status restored', async t => {
  enableClock(t);
  for (const event of ['session_start', 'session_tree', 'session_shutdown']) {
    const h = harness(t); await h.start(); await h.run();
    await h.emit(event); assert.equal(h.title(), '标签状态增强');
    const count = h.titles.length;
    t.mock.timers.tick(2000); assert.equal(h.titles.length, count);
  }
});

test('two sessions animate independently and shutdown does not affect the other', async t => {
  enableClock(t);
  const a = harness(t, { name: '任务甲' }), b = harness(t, { name: '任务乙' });
  await a.start(); await b.start(); await a.run(); await b.run();
  await a.message(); await a.settle(); await a.emit('session_shutdown');
  t.mock.timers.tick(200);
  assert.equal(a.title(), '任务甲'); assert.equal(b.title(), '⠙ 任务乙');
});

test('non-TUI modes create no animations or title writes', async t => {
  enableClock(t);
  for (const mode of ['print', 'json', 'rpc']) {
    const h = harness(t, { mode }); await h.start(); await h.run();
    t.mock.timers.tick(500); await h.message(); await h.settle();
    assert.deepEqual(h.titles, []); assert.deepEqual(h.entries, []);
  }
});

test('timer callback UI failure is contained and stops animation', async t => {
  enableClock(t);
  const h = harness(t); await h.start(); await h.run();
  let calls = 0;
  const setTitle = h.ctx.ui.setTitle;
  h.ctx.ui.setTitle = () => { calls++; throw Error('disposed UI'); };
  t.mock.timers.tick(2000); assert.equal(calls, 1);
  h.ctx.ui.setTitle = setTitle;
});
