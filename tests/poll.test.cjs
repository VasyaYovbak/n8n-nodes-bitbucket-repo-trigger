const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BitbucketRepositoryPoll } = require('../dist/nodes/BitbucketRepositoryPoll/BitbucketRepositoryPoll.node.js');
const { BitbucketRepositoryToken } = require('../dist/credentials/BitbucketRepositoryToken.credentials.js');
const { NodeHelpers } = require('n8n-workflow');

const source = 'a'.repeat(40);
const destination = 'b'.repeat(40);
const otherSource = 'c'.repeat(40);
const otherDestination = 'd'.repeat(40);
const base = 'https://api.bitbucket.org/2.0/repositories/dashfin/test-repo/pullrequests';
const pr = (id, src = source, dst = destination) => ({
  id, state: 'OPEN', title: `PR ${id}`,
  source: { commit: { hash: src } }, destination: { commit: { hash: dst } },
});

function fixture() {
  const node = new BitbucketRepositoryPoll();
  const state = {};
  const params = { workspace: 'dashfin', repository: 'test-repo', includeExisting: false, events: ['pullrequest:created', 'pullrequest:updated'], agentName: '', agentAccountId: '' };
  const calls = [];
  const api = { pages: [{ values: [] }], commentPages: {}, error: null, commentError: null };
  let mode = 'trigger';
  const context = {
    getNode: () => ({ name: 'Poll' }),
    getMode: () => mode,
    getNodeParameter: (name, fallback) => params[name] ?? fallback,
    getWorkflowStaticData: () => state,
    helpers: {
      httpRequestWithAuthentication: async (credential, options) => {
        calls.push({ credential, ...options });
        if (api.error) throw api.error;
        const url = new URL(options.url);
        const page = url.searchParams.get('page');
        const commentPath = /\/pullrequests\/(\d+)\/comments$/.exec(url.pathname);
        if (commentPath) {
          if (api.commentError) throw api.commentError;
          return (api.commentPages[commentPath[1]] ?? [{ values: [] }])[page ? Number(page) - 1 : 0];
        }
        return api.pages[page ? Number(page) - 1 : 0];
      },
      returnJsonArray: (values) => values.map((json) => ({ json })),
    },
  };
  return { node, state, params, calls, api, context, setMode: (value) => { mode = value; } };
}

test('poll node uses the same repository credential without requiring a webhook secret', () => {
  const node = new BitbucketRepositoryPoll();
  assert.equal(node.description.polling, true);
  assert.equal(node.description.credentials[0].name, 'bitbucketRepositoryToken');
  assert.notEqual(new BitbucketRepositoryToken().properties.find((prop) => prop.name === 'webhookSecret').required, true);
});

test('mention settings are visible only when mention events are selected', () => {
  const node = new BitbucketRepositoryPoll();
  for (const name of ['agentName', 'agentAccountId']) {
    const field = node.description.properties.find((property) => property.name === name);
    assert.equal(NodeHelpers.displayParameter({ events: ['pullrequest:created', 'pullrequest:comment:mention'] }, field, null, node.description), true);
    assert.equal(NodeHelpers.displayParameter({ events: ['pullrequest:created'] }, field, null, node.description), false);
  }
});

test('first automatic poll records existing PRs and later emits only a new PR', async () => {
  const f = fixture();
  f.api.pages = [{ values: [pr(1)] }];
  assert.equal(await f.node.poll.call(f.context), null);
  assert.deepEqual(f.state.revisions, { 1: `${source.slice(0, 12)}:${destination.slice(0, 12)}` });
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.pages = [{ values: [pr(1), pr(2)] }];
  const result = await f.node.poll.call(f.context);
  assert.equal(result[0].length, 1);
  assert.equal(result[0][0].json.event, 'pullrequest:created');
  assert.equal(result[0][0].json.body.pullrequest.id, 2);
  assert.equal(result[0][0].json.body.repository.full_name, 'dashfin/test-repo');
  assert.match(result[0][0].json.revision_key, /^dashfin\/test-repo#2:/);
  assert.equal(await f.node.poll.call(f.context), null);
  assert.ok(f.calls.every((call) => call.credential === 'bitbucketRepositoryToken' && call.method === 'GET' && call.disableFollowRedirect));
});

test('reports changed source and destination commits, but not title-only edits', async () => {
  const f = fixture();
  f.api.pages = [{ values: [pr(1)] }];
  await f.node.poll.call(f.context);
  f.api.pages = [{ values: [{ ...pr(1), title: 'edited title' }] }];
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.pages = [{ values: [pr(1, otherSource)] }];
  assert.equal((await f.node.poll.call(f.context))[0][0].json.event, 'pullrequest:updated');
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.pages = [{ values: [pr(1, otherSource, otherDestination)] }];
  assert.equal((await f.node.poll.call(f.context))[0][0].json.event, 'pullrequest:updated');
});

test('accepts Bitbucket 12-character commit prefixes and detects new commits', async () => {
  const f = fixture();
  f.api.pages = [{ values: [pr(3, source.slice(0, 12), destination.slice(0, 12))] }];
  f.setMode('manual');
  assert.equal((await f.node.poll.call(f.context))[0][0].json.event, 'poll:test');
  assert.deepEqual(f.state, {});
  f.setMode('trigger');
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.pages = [{ values: [pr(3, otherSource.slice(0, 12), destination.slice(0, 12))] }];
  const result = await f.node.poll.call(f.context);
  assert.equal(result[0][0].json.event, 'pullrequest:updated');
  assert.equal(result[0][0].json.body.pullrequest.source.commit.hash.length, 12);
});

test('normalizes old full-length saved hashes and 12-character API prefixes', async () => {
  const f = fixture();
  f.state.repositoryKey = 'dashfin/test-repo';
  f.state.revisions = { 1: `${source}:${destination}` };
  f.api.pages = [{ values: [pr(1, source.slice(0, 12), destination.slice(0, 12))] }];
  assert.equal(await f.node.poll.call(f.context), null);
  assert.equal(f.state.revisions[1], `${source.slice(0, 12)}:${destination.slice(0, 12)}`);
  f.api.pages = [{ values: [pr(1, source, destination)] }];
  assert.equal(await f.node.poll.call(f.context), null);
});

test('rejects invalid or overly short commit prefixes', async () => {
  for (const invalid of ['a'.repeat(11), 'z'.repeat(12), '', 'a'.repeat(65)]) {
    const f = fixture();
    f.api.pages = [{ values: [pr(1, invalid, destination.slice(0, 12))] }];
    await assert.rejects(f.node.poll.call(f.context), /without a valid ID/);
    assert.deepEqual(f.state, {});
  }
});

test('can opt in to reviewing open PRs on the first automatic poll', async () => {
  const f = fixture();
  f.params.includeExisting = true;
  f.api.pages = [{ values: [pr(1), pr(2)] }];
  const result = await f.node.poll.call(f.context);
  assert.deepEqual(result[0].map((item) => item.json.event), ['pullrequest:created', 'pullrequest:created']);
  assert.equal(await f.node.poll.call(f.context), null);
});

test('manual test returns one sample and never alters saved state', async () => {
  const f = fixture();
  f.setMode('manual');
  f.api.pages = [{ values: [pr(1), pr(2)] }];
  const result = await f.node.poll.call(f.context);
  assert.equal(result[0].length, 1);
  assert.equal(result[0][0].json.event, 'poll:test');
  assert.deepEqual(f.state, {});
  f.setMode('trigger');
  assert.equal(await f.node.poll.call(f.context), null);
});

test('collects every Bitbucket page before updating state', async () => {
  const f = fixture();
  f.params.includeExisting = true;
  f.api.pages = [
    { values: [pr(1)], next: `${base}?state=OPEN&pagelen=50&page=2` },
    { values: [pr(2)] },
  ];
  const result = await f.node.poll.call(f.context);
  assert.deepEqual(result[0].map((item) => item.json.body.pullrequest.id), [1, 2]);
  assert.equal(f.calls.length, 2);
  assert.equal(Object.keys(f.state.revisions).length, 2);
});

test('failed or malformed later pages do not advance saved state', async () => {
  for (const next of [
    'https://attacker.example/steal',
    'https://api.bitbucket.org/2.0/repositories/dashfin/other/pullrequests?page=2',
    'https://user:password@api.bitbucket.org/2.0/repositories/dashfin/test-repo/pullrequests?page=2',
    `${base}?state=OPEN&pagelen=50`,
  ]) {
    const f = fixture();
    f.state.repositoryKey = 'dashfin/test-repo';
    f.state.revisions = { 7: 'previous-value' };
    const before = structuredClone(f.state);
    f.api.pages = [{ values: [pr(1)], next }];
    await assert.rejects(f.node.poll.call(f.context));
    assert.deepEqual(f.state, before);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture();
  f.state.repositoryKey = 'dashfin/test-repo';
  f.state.revisions = { 7: 'previous-value' };
  const before = structuredClone(f.state);
  f.api.pages = [{ values: [pr(1)], next: `${base}?page=2` }, { invalid: true }];
  await assert.rejects(f.node.poll.call(f.context), /invalid pull request list/);
  assert.deepEqual(f.state, before);
});

test('API errors and a PR changing between pages do not advance saved state', async () => {
  const f = fixture();
  f.state.repositoryKey = 'dashfin/test-repo';
  f.state.revisions = { 7: 'previous-value' };
  const before = structuredClone(f.state);
  f.api.error = new Error('Bitbucket unavailable');
  await assert.rejects(f.node.poll.call(f.context), /Bitbucket unavailable/);
  assert.deepEqual(f.state, before);
  f.api.error = null;
  f.api.pages = [{ values: [pr(1)], next: `${base}?page=2` }, { values: [pr(1, otherSource)] }];
  await assert.rejects(f.node.poll.call(f.context), /changed while fetching pages/);
  assert.deepEqual(f.state, before);
});

test('rejects invalid repositories or incomplete PR data without changing state', async () => {
  const f = fixture();
  f.params.workspace = '../escape';
  await assert.rejects(f.node.poll.call(f.context), /Invalid workspace/);
  assert.equal(f.calls.length, 0);
  f.params.workspace = 'dashfin';
  f.api.pages = [{ values: [{ id: 1, state: 'OPEN', source: { commit: { hash: source } } }] }];
  await assert.rejects(f.node.poll.call(f.context), /without a valid ID/);
  assert.deepEqual(f.state, {});
});

test('uses a separate baseline after changing repository', async () => {
  const f = fixture();
  f.api.pages = [{ values: [pr(1)] }];
  await f.node.poll.call(f.context);
  f.params.repository = 'other';
  assert.equal(await f.node.poll.call(f.context), null);
  assert.equal(f.state.repositoryKey, 'dashfin/other');
});

const mentionEvent = 'pullrequest:comment:mention';
const comment = (id, raw, extra = {}) => ({ id, content: { raw }, updated_on: '2026-01-01T12:00:00Z', ...extra });

function mentionFixture() {
  const f = fixture();
  f.params.events = [mentionEvent];
  f.params.agentName = '@agent';
  f.api.pages = [{ values: [pr(1)] }];
  return f;
}

test('only emits selected PR events and preserves default polling behavior', async () => {
  const f = fixture();
  f.params.events = ['pullrequest:updated'];
  f.params.includeExisting = true;
  f.api.pages = [{ values: [pr(1)] }];
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.pages = [{ values: [pr(1), pr(2)] }];
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.pages = [{ values: [pr(1, otherSource), pr(2)] }];
  assert.equal((await f.node.poll.call(f.context))[0][0].json.event, 'pullrequest:updated');
  assert.ok(f.calls.every((call) => !call.url.includes('/comments')));
});

test('existing workflows without the events parameter keep created and updated events', async () => {
  const f = fixture();
  delete f.params.events;
  f.api.pages = [{ values: [pr(1)] }];
  await f.node.poll.call(f.context);
  f.api.pages = [{ values: [pr(1, otherSource), pr(2)] }];
  assert.deepEqual((await f.node.poll.call(f.context))[0].map((item) => item.json.event), ['pullrequest:updated', 'pullrequest:created']);
});

test('baselines existing comments and emits new text and account mentions including inline replies', async () => {
  const f = mentionFixture();
  f.params.agentAccountId = '712020:abc-def';
  f.api.commentPages[1] = [{ values: [comment(1, 'old @agent')] }];
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.commentPages[1] = [
    { values: [comment(1, 'old @agent'), comment(2, 'please @Agent.', { inline: { path: 'file.ts', to: 3 }, parent: { id: 1 } })], next: `${base}/1/comments?page=2` },
    { values: [comment(3, 'please review @{712020:abc-def}'), comment(4, 'no match')] },
  ];
  const result = await f.node.poll.call(f.context);
  assert.deepEqual(result[0].map((item) => item.json.event), [mentionEvent, mentionEvent]);
  assert.deepEqual(result[0].map((item) => item.json.body.comment.id), [2, 3]);
  assert.equal(result[0][0].json.body.pullrequest.id, 1);
  assert.deepEqual(result[0][0].json.body.comment.parent, { id: 1 });
  assert.match(result[0][0].json.event_key, /#1:comment:2:2026-/);
  assert.equal(await f.node.poll.call(f.context), null);
});

test('does not match similar names, email addresses, deleted or pending comments', async () => {
  const f = mentionFixture();
  await f.node.poll.call(f.context);
  f.api.commentPages[1] = [{ values: [
    comment(1, '@agent-other'), comment(2, '@agent.example'), comment(3, 'email@agent'),
    comment(4, '@other'), comment(5, '@agent', { deleted: true }), comment(6, '@agent', { pending: true }),
  ] }];
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.commentPages[1][0].values[5].pending = false;
  assert.equal((await f.node.poll.call(f.context))[0][0].json.body.comment.id, 6);
});

test('detects a mention added to an existing comment and does not repeat unrelated edits', async () => {
  const f = mentionFixture();
  f.api.commentPages[1] = [{ values: [comment(1, 'not yet')] }];
  await f.node.poll.call(f.context);
  f.api.commentPages[1] = [{ values: [comment(1, 'please @agent', { updated_on: '2026-01-01T12:01:00Z' })] }];
  const first = (await f.node.poll.call(f.context))[0][0].json;
  assert.equal(first.body.comment.id, 1);
  f.api.commentPages[1] = [{ values: [comment(1, 'please @agent again', { updated_on: '2026-01-01T12:02:00Z' })] }];
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.commentPages[1] = [{ values: [comment(1, 'removed')] }];
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.commentPages[1] = [{ values: [comment(1, '@agent again', { updated_on: '2026-01-01T12:03:00Z' })] }];
  const second = (await f.node.poll.call(f.context))[0][0].json;
  assert.notEqual(first.event_key, second.event_key);
});

test('detects mentions in newly discovered PRs and can emit several event types', async () => {
  const f = mentionFixture();
  f.params.events = ['pullrequest:created', 'pullrequest:updated', mentionEvent];
  await f.node.poll.call(f.context);
  f.api.pages = [{ values: [pr(1, otherSource), pr(2)] }];
  f.api.commentPages[2] = [{ values: [comment(7, '@agent hi')] }];
  const result = await f.node.poll.call(f.context);
  assert.deepEqual(result[0].map((item) => item.json.event), ['pullrequest:updated', 'pullrequest:created', mentionEvent]);
  assert.equal(result[0][2].json.body.comment.id, 7);
});

test('enabling or changing the mention target baselines comments without replay', async () => {
  const f = fixture();
  f.api.pages = [{ values: [pr(1)] }];
  f.api.commentPages[1] = [{ values: [comment(1, '@agent'), comment(2, '@other')] }];
  await f.node.poll.call(f.context);
  f.params.events.push(mentionEvent);
  f.params.agentName = 'agent';
  assert.equal(await f.node.poll.call(f.context), null);
  f.params.agentName = 'other';
  assert.equal(await f.node.poll.call(f.context), null);
  f.api.commentPages[1][0].values.push(comment(3, '@other'));
  assert.equal((await f.node.poll.call(f.context))[0][0].json.body.comment.id, 3);
});

test('accepts account ID without a name and rejects invalid settings before requests', async () => {
  const f = mentionFixture();
  f.params.agentName = '';
  f.params.agentAccountId = 'account:123';
  await f.node.poll.call(f.context);
  f.api.commentPages[1] = [{ values: [comment(1, '@{account:123}'), comment(2, '@{account:1234}')] }];
  assert.deepEqual((await f.node.poll.call(f.context))[0].map((item) => item.json.body.comment.id), [1]);
  for (const [name, value] of [['events', []], ['events', ['unknown']], ['agentName', 'bad name'], ['agentAccountId', '../bad']]) {
    const invalid = mentionFixture();
    invalid.params[name] = value;
    await assert.rejects(invalid.node.poll.call(invalid.context));
    assert.equal(invalid.calls.length, 0);
  }
  const empty = mentionFixture();
  empty.params.agentName = '';
  await assert.rejects(empty.node.poll.call(empty.context), /Enter an agent name/);
  assert.equal(empty.calls.length, 0);
});

test('comment errors and unsafe pagination leave all polling state unchanged', async () => {
  const f = mentionFixture();
  await f.node.poll.call(f.context);
  const before = structuredClone(f.state);
  f.api.pages = [{ values: [pr(1, otherSource)] }];
  f.api.commentError = new Error('Forbidden');
  await assert.rejects(f.node.poll.call(f.context), /Forbidden/);
  assert.deepEqual(f.state, before);
  f.api.commentError = null;
  f.api.commentPages[1] = [{ values: [comment(1, '@agent')], next: 'https://attacker.example/steal' }];
  await assert.rejects(f.node.poll.call(f.context), /outside the selected repository/);
  assert.deepEqual(f.state, before);
  assert.ok(f.calls.every((call) => !call.url.includes('attacker.example')));
});

test('manual test with mention selection does not inspect comments or modify state', async () => {
  const f = mentionFixture();
  f.setMode('manual');
  assert.equal((await f.node.poll.call(f.context))[0][0].json.event, 'poll:test');
  assert.deepEqual(f.state, {});
  assert.ok(f.calls.every((call) => !call.url.includes('/comments')));
});
