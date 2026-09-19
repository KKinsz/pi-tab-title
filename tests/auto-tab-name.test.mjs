import assert from 'node:assert/strict';
import { test } from 'node:test';
import extension, { cleanTitle, textOnly } from '../index.ts';
import { isolateConfig } from './isolated-config.mjs';
isolateConfig();
const flush = () => new Promise(resolve => setTimeout(resolve, 15));
const ENTRY = 'auto-tab-name:v1';
const answer = (text = '移动登录设计', stopReason = 'stop') => ({ role: 'assistant', stopReason, content: [{ type: 'text', text }] });
const user = text => ({ type: 'message', message: { role: 'user', content: text } });
const assistant = text => ({ type: 'message', message: answer(text) });
const titleModel = { id: 'small-model', provider: 'example', reasoning: true };
function harness({ entries = [], name, mode = 'tui', complete, idle = true, confirm = true, model = titleModel } = {}) {
  const hooks = {}, commands = {}, tools = {}, titles = [], notices = [], calls = [];
  let currentName = name;
  let pending = [];
  const ctx = {
    mode, isIdle: () => idle, model,
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    ui: {
      setTitle: value => titles.push(value), notify: (...args) => notices.push(args),
      confirm: async () => typeof confirm === 'function' ? confirm() : confirm,
    },
    modelRegistry: {
      // Consulted only when a global naming-model preference has been saved.
      find: () => model,
      complete: (...args) => { calls.push(args); return complete ? complete(...args) : Promise.resolve(answer()); },
    },
  };
  const pi = {
    on: (name, handler) => (hooks[name] ??= []).push(handler),
    registerCommand: (name, spec) => commands[name] = spec,
    registerTool: spec => tools[spec.name] = spec,
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    getSessionName: () => currentName,
    setSessionName: name => { currentName = name; pending.push(emit('session_info_changed', { name })); },
  };
  extension(pi);
  async function emit(name, event = {}) { for (const fn of hooks[name] ?? []) await fn(event, ctx); }
  async function start() { await emit('session_start'); }
  async function round(prompt = '设计移动端登录', response = answer('我们先梳理登录流程')) {
    entries.push(user(prompt));
    await emit('input', { text: prompt, source: 'interactive' });
    await emit('before_agent_start', { prompt });
    await emit('message_end', { message: response });
    entries.push({ type: 'message', message: response });
    await emit('agent_settled'); await flush(); await Promise.all(pending); pending = [];
  }
  return { ctx, emit, start, round, entries, titles, notices, calls, commands, tools, name: () => currentName };
}

test('text extraction excludes tools, images and thinking', () => {
  assert.equal(textOnly([{ type: 'text', text: '用户目标' }, { type: 'thinking', thinking: 'secret' }, { type: 'toolCall', arguments: 'secret' }]), '用户目标');
});
test('title sanitization strips terminal and bidi controls; bounds codepoints', () => {
  assert.equal(cleanTitle('\x1b]2;evil\x07“登录排查”\u202e'), '登录排查');
  assert.equal(cleanTitle('\x1b[31m中文\x1b[0m'), '中文');
  assert.equal(Array.from(cleanTitle('中'.repeat(30))).length, 24);
  assert.equal(cleanTitle('\x07\x1b'), '');
});
test('first prompt triggers exactly once, names terminal and session', async () => {
  const h = harness(); await h.start(); await h.round();
  assert.equal(h.calls.length, 1); assert.equal(h.titles.at(-1), '移动登录设计');
  assert.equal(h.name(), '移动登录设计');
  await h.round('现在讨论模型选型'); assert.equal(h.calls.length, 1);
});
test('naming starts before any answer, while main agent is busy, without blocking', async () => {
  let resolve;
  const h = harness({ idle: false, complete: () => new Promise(r => resolve = r) }); await h.start();
  await h.emit('before_agent_start', { prompt: '测试首条输入' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], titleModel);
  assert.equal(h.ctx.model.id, 'small-model');
  assert.equal(h.entries.at(-1).data.status, 'pending');
  await h.emit('message_end', { message: answer('工具调用', 'toolUse') });
  await h.emit('message_end', { message: answer('最终回复') });
  await h.emit('agent_settled'); assert.equal(h.calls.length, 1);
  resolve(answer()); await flush(); assert.equal(h.name(), '移动登录设计');
});
test('queued follow-up does not replace first prompt or send assistant data', async () => {
  const h = harness(); await h.start();
  await h.emit('input', { text: '原始首轮', source: 'interactive' });
  await h.emit('before_agent_start', { prompt: '扩展后的巨型提示' });
  await h.emit('message_end', { message: answer('首轮回复') });
  await h.emit('before_agent_start', { prompt: '后续请求' });
  await h.emit('message_end', { message: answer('后续回复') });
  await h.emit('agent_settled'); await flush();
  assert.deepEqual(JSON.parse(h.calls[0][1].messages[0].content), { user: '原始首轮' });
});
test('resume/reload uses saved title without a new call', async () => {
  const h = harness(); await h.start(); await h.round();
  const resumed = harness({ entries: h.entries, name: h.name() });
  await resumed.start(); await resumed.round('继续');
  assert.equal(resumed.titles.at(-1), '移动登录设计'); assert.equal(resumed.calls.length, 0);
});
test('old session without state is skipped, explicit auto still works', async () => {
  const h = harness({ entries: [user('历史首问'), assistant('历史回复')] });
  await h.start(); await h.round(); assert.equal(h.calls.length, 0);
  await h.commands.tabname.handler('auto', h.ctx); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.calls[0][1].messages[0].content).user, '历史首问');
});
test('restored pending attempt is not retried', async () => {
  const h = harness({ entries: [{ type: 'custom', customType: ENTRY, data: { version: 1, status: 'pending' } }] });
  await h.start(); await h.round(); assert.equal(h.calls.length, 0);
});
test('existing custom session name is respected', async () => {
  const h = harness({ name: '手工会话名' }); await h.start(); await h.round();
  assert.equal(h.titles.at(-1), '手工会话名'); assert.equal(h.calls.length, 0);
});
test('manual command before first round disables auto naming', async () => {
  const h = harness(); await h.start(); await h.commands.tabname.handler('指定标题', h.ctx);
  await h.round(); assert.equal(h.calls.length, 0); assert.equal(h.name(), '指定标题');
});
test('late automatic response cannot overwrite manual rename', async () => {
  let resolve; const h = harness({ complete: () => new Promise(r => resolve = r) });
  await h.start(); await h.round(); assert.equal(h.calls.length, 1);
  await h.commands.tabname.handler('手动优先', h.ctx); resolve(answer('过期自动标题')); await flush();
  assert.equal(h.titles.at(-1), '手动优先'); assert.equal(h.name(), '手动优先');
});
test('shutdown cancels in-flight work and prevents stale session writes', async () => {
  let resolve; const h = harness({ complete: () => new Promise(r => resolve = r) });
  await h.start(); await h.round(); const length = h.entries.length;
  await h.emit('session_shutdown'); resolve(answer()); await flush();
  assert.equal(h.entries.length, length); assert.equal(h.titles.length, 0);
});
test('tree navigation preserves existing name and never re-arms', async () => {
  const h = harness(); await h.start(); await h.round();
  await h.emit('session_tree'); await h.round('新分支');
  assert.equal(h.calls.length, 1); assert.equal(h.titles.at(-1), '移动登录设计');
});
test('network failure is one-shot, generic notification only', async () => {
  const h = harness({ complete: async () => { throw Error('sensitive auth value'); } });
  await h.start(); await h.round(); await h.round();
  assert.equal(h.calls.length, 1); assert.equal(h.notices.length, 1);
  assert.ok(!JSON.stringify(h.notices).includes('sensitive'));
});
test('invalid or incomplete model title is rejected without auto retry', async () => {
  for (const result of [answer('An English title'), answer('这是一个超过十个字的中文标题'), answer('标题\n解释'), answer('登录界面', 'length')]) {
    const h = harness({ complete: async () => result }); await h.start(); await h.round();
    assert.equal(h.titles.length, 0); assert.equal(h.entries.filter(e => e.type === 'custom').at(-1).data.status, 'failed');
  }
});
test('aborting main answer does not require a new naming request', async () => {
  const h = harness(); await h.start(); await h.round('首问', answer('', 'aborted')); await h.round();
  assert.equal(h.calls.length, 1); assert.equal(h.name(), '移动登录设计');
});
test('print/json/rpc do not write terminal, persist state, or call model', async () => {
  for (const mode of ['print', 'json', 'rpc']) {
    const h = harness({ mode }); await h.start(); await h.round(); await h.commands.tabname.handler('命名', h.ctx);
    assert.equal(h.calls.length, 0); assert.equal(h.titles.length, 0);
    assert.ok(h.entries.every(e => e.type !== 'custom'));
  }
});
test('natural-language tool requires confirmation', async () => {
  for (const confirm of [false, true]) {
    const h = harness({ confirm }); await h.start();
    const result = await h.tools.rename_session_tab.execute('id', { title: '自然语言改名' }, new AbortController().signal, undefined, h.ctx);
    assert.equal(result.details.renamed, confirm); assert.equal(h.name(), confirm ? '自然语言改名' : undefined);
  }
});
test('/name event syncs terminal and takes precedence over pending auto', async () => {
  let resolve; const h = harness({ complete: () => new Promise(r => resolve = r) });
  await h.start(); await h.round(); await h.emit('session_info_changed', { name: '外部手动名称' });
  resolve(answer()); await flush(); assert.equal(h.titles.at(-1), '外部手动名称');
});
test('a new runtime starts clean and each tab is isolated', async () => {
  const first = harness(); const second = harness(); await first.start(); await second.start();
  await first.commands.tabname.handler('第一个标签', first.ctx); await second.round();
  assert.equal(first.name(), '第一个标签'); assert.equal(second.name(), '移动登录设计');
});
test('prompt bounded to 1000 chars; no answer; deadline, low reasoning and isolated affinity', async () => {
  const h = harness(); await h.start(); await h.round('中'.repeat(10_000), answer('文'.repeat(10_000)));
  const [, context, options] = h.calls[0];
  const data = JSON.parse(context.messages[0].content);
  assert.equal(data.user.length, 1000); assert.deepEqual(Object.keys(data), ['user']);
  assert.equal(options.maxTokens, 1024); assert.ok(options.signal); assert.ok(options.sessionId);
  assert.equal(options.reasoningEffort, 'low'); assert.equal(options.cacheRetention, 'none');
});
test('no usable naming model fails once instead of silently using another model', async () => {
  const h = harness();
  h.ctx.model = undefined;
  await h.start(); await h.round(); await h.round();
  assert.equal(h.calls.length, 0); assert.equal(h.notices.length, 1);
  assert.equal(h.entries.filter(e => e.type === 'custom').at(-1).data.status, 'failed');
});
test('explicit auto works with only first user prompt, even while main reply is busy', async () => {
  const h = harness({ entries: [user('历史首问')], idle: false }); await h.start();
  await h.commands.tabname.handler('auto', h.ctx); await flush();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0][1].messages[0].content), { user: '历史首问' });
});
test('repeated auto command does not duplicate an in-flight request', async () => {
  let resolve; const h = harness({ complete: () => new Promise(r => resolve = r) });
  await h.start(); await h.round();
  await h.commands.tabname.handler('auto', h.ctx); assert.equal(h.calls.length, 1);
  resolve(answer()); await flush();
  await h.commands.tabname.handler('auto', h.ctx); assert.equal(h.calls.length, 2);
  resolve(answer()); await flush();
});
test('image-only and whitespace first input skip without using expanded body', async () => {
  for (const text of ['', '   ']) {
    const h = harness(); await h.start();
    await h.emit('input', { text, source: 'interactive' });
    await h.emit('before_agent_start', { prompt: 'expanded attachment content' });
    assert.equal(h.calls.length, 0); assert.equal(h.entries.at(-1).data.status, 'skipped');
    await h.round(); assert.equal(h.calls.length, 0);
  }
});
test('confirmed tool rename wins over a late auto response while dialog is open', async () => {
  let resolveAuto, resolveConfirm;
  const h = harness({ complete: () => new Promise(r => resolveAuto = r), confirm: () => new Promise(r => resolveConfirm = r) });
  await h.start(); await h.round();
  const result = h.tools.rename_session_tab.execute('id', { title: '手动工具优先' }, new AbortController().signal, undefined, h.ctx);
  assert.equal(h.calls[0][2].signal.aborted, true);
  resolveAuto(answer()); await flush(); assert.equal(h.titles.length, 0);
  resolveConfirm(true); assert.equal((await result).details.renamed, true);
  assert.equal(h.name(), '手动工具优先');
});
test('restored failed/skipped state never retries automatically', async () => {
  for (const status of ['failed', 'skipped']) {
    const h = harness({ entries: [{ type: 'custom', customType: ENTRY, data: { version: 1, status } }] });
    await h.start(); await h.round(); assert.equal(h.calls.length, 0);
  }
});
test('restored pending state can be explicitly retried', async () => {
  const h = harness({ entries: [user('重试首问'), { type: 'custom', customType: ENTRY, data: { version: 1, status: 'pending' } }] });
  await h.start(); await h.commands.tabname.handler('auto', h.ctx); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.name(), '移动登录设计');
});
