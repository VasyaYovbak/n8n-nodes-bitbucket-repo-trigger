const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BitbucketRepository } = require('../dist/nodes/BitbucketRepository/BitbucketRepository.node.js');

const root = '/2.0/repositories/dashfin/test-repo';
const base = `https://api.bitbucket.org${root}`;
const source = '0123456789ab';
const destination = 'abcdef123456';
const comment = (id, extra = {}) => ({ id, content: { raw: `comment ${id}`, html: `<p>comment ${id}</p>` }, ...extra });
const detail = (id) => ({
  id, state: 'OPEN', title: `PR ${id}`, description: 'all metadata', custom_field: { untouched: true },
  source: { commit: { hash: source } }, destination: { commit: { hash: destination } },
});

function fixture() {
  const node = new BitbucketRepository();
  const inputs = [{}];
  const params = { resource: 'pullRequest', operation: 'getContext', workspace: 'dashfin', repository: 'test-repo', pullRequestId: 3 };
  const calls = [];
  const api = { prReads: 0, after: null, override: null, error: null };
  const context = {
    getInputData: () => inputs,
    getNode: () => ({ name: 'Bitbucket Repository' }),
    getNodeParameter: (key, i) => Array.isArray(params[key]) ? params[key][i] : params[key],
    continueOnFail: () => false,
    helpers: {
      httpRequestWithAuthentication: async (credential, options) => {
        calls.push({ credential, ...options });
        if (api.error) throw api.error;
        if (api.override) {
          const result = api.override(options);
          if (result) return result;
        }
        const url = new URL(options.url);
        const id = Number(/\/pullrequests\/(\d+)/.exec(url.pathname)?.[1] ?? 3);
        const ok = (body) => ({ statusCode: 200, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) });
        if (url.pathname === `${root}/pullrequests/${id}`) {
          api.prReads++;
          return ok(api.prReads % 2 === 0 && api.after ? api.after : detail(id));
        }
        if (url.pathname === `${root}/pullrequests/${id}/diff`) {
          return { statusCode: 302, headers: { location: `${base}/diff/deadbeef%0Dabcdef?from_pullrequest_id=${id}` }, body: '' };
        }
        if (url.pathname === `${root}/diff/deadbeef%0Dabcdef`) return ok('diff --git a/a b/a\n-old\n+new\n');
        if (url.pathname === `${root}/pullrequests/${id}/diffstat`) {
          return { statusCode: 302, headers: { Location: `${base}/diffstat/deadbeef%0Dabcdef?from_pullrequest_id=${id}` }, body: '' };
        }
        if (url.pathname === `${root}/diffstat/deadbeef%0Dabcdef`) return ok({ values: [{ status: 'modified', new: { path: 'a.ts' }, lines_added: 1 }] });
        if (url.pathname === `${root}/pullrequests/${id}/comments`) {
          if (url.searchParams.get('page') === '2') return ok({ values: [comment(3, { deleted: true })] });
          return ok({
            values: [comment(1, { inline: { path: 'a.ts', to: 2 } }), comment(2, { parent: { id: 1 }, resolution: { type: 'resolved' } })],
            next: `${base}/pullrequests/${id}/comments?page=2`,
          });
        }
        if (url.pathname === `${root}/pullrequests/${id}/commits`) return ok({ values: [{ hash: 'a'.repeat(40), message: 'first' }] });
        throw new Error(`unexpected test URL: ${options.url}`);
      },
    },
  };
  return { node, inputs, params, calls, api, context };
}

test('gets PR metadata, complete comments, commits, changed files and raw diff', async () => {
  const f = fixture();
  const result = await f.node.execute.call(f.context);
  assert.equal(result[0].length, 1);
  const item = result[0][0];
  assert.deepEqual(item.pairedItem, { item: 0 });
  assert.deepEqual(item.json.pull_request, detail(3));
  assert.equal(item.json.diff, 'diff --git a/a b/a\n-old\n+new\n');
  assert.deepEqual(item.json.comments, [
    comment(1, { inline: { path: 'a.ts', to: 2 } }),
    comment(2, { parent: { id: 1 }, resolution: { type: 'resolved' } }),
    comment(3, { deleted: true }),
  ]);
  assert.deepEqual(item.json.commits, [{ hash: 'a'.repeat(40), message: 'first' }]);
  assert.deepEqual(item.json.changed_files, [{ status: 'modified', new: { path: 'a.ts' }, lines_added: 1 }]);
  assert.deepEqual(item.json.retrieval, { commit_prefixes_unchanged: true });
  assert.ok(f.calls.every((call) => call.credential === 'bitbucketRepositoryToken' && call.method === 'GET' && call.disableFollowRedirect));
  assert.equal(f.calls.filter((call) => new URL(call.url).pathname.endsWith('/comments')).length, 2);
});

test('supports multiple incoming PRs and pairs outputs with their original items', async () => {
  const f = fixture();
  f.inputs.push({});
  f.params.pullRequestId = [3, '4'];
  const result = await f.node.execute.call(f.context);
  assert.deepEqual(result[0].map((item) => item.json.pull_request.id), [3, 4]);
  assert.deepEqual(result[0].map((item) => item.pairedItem.item), [0, 1]);
});

test('rejects external or unrelated redirect URLs without forwarding credentials', async () => {
  for (const url of [
    'https://attacker.example/diff',
    'https://user:secret@api.bitbucket.org/2.0/repositories/dashfin/test-repo/diff/hash',
    'https://api.bitbucket.org/2.0/repositories/dashfin/other/diff/hash',
    `${base}/hooks`,
  ]) {
    const f = fixture();
    f.api.override = (options) => options.url.endsWith('/diff') ? { statusCode: 302, headers: { location: url } } : null;
    await assert.rejects(f.node.execute.call(f.context), /outside the requested repository resource/);
    assert.ok(f.calls.every((call) => !call.url.includes('attacker.example') && !call.url.includes('/other/')));
  }
});

test('rejects unsafe or repeated comment pagination rather than silently dropping comments', async () => {
  for (const next of [
    'https://attacker.example/collect',
    `${base}/pullrequests/4/comments?page=2`,
    `${base}/pullrequests/3/comments?pagelen=100`,
  ]) {
    const f = fixture();
    f.api.override = (options) => options.url.includes('/comments?')
      ? { statusCode: 200, body: JSON.stringify({ values: [comment(1)], next }) }
      : null;
    await assert.rejects(f.node.execute.call(f.context), /outside the requested repository resource|pagination exceeded/);
    assert.ok(f.calls.every((call) => !call.url.includes('attacker.example')));
  }
});

test('fails if a source commit, destination commit or PR state changes during retrieval', async () => {
  for (const after of [
    { ...detail(3), source: { commit: { hash: 'f'.repeat(12) } } },
    { ...detail(3), destination: { commit: { hash: 'f'.repeat(12) } } },
    { ...detail(3), state: 'MERGED' },
  ]) {
    const f = fixture();
    f.api.after = after;
    await assert.rejects(f.node.execute.call(f.context), /changed while its context was being fetched/);
  }
});

test('allows matching abbreviated/full hashes without claiming full identity verification', async () => {
  const f = fixture();
  f.api.after = { ...detail(3), source: { commit: { hash: source + 'f'.repeat(28) } } };
  const result = await f.node.execute.call(f.context);
  assert.deepEqual(result[0][0].json.retrieval, { commit_prefixes_unchanged: true });
});

test('reports unavailable commit information and preserves all other metadata', async () => {
  const f = fixture();
  f.api.override = (options) => {
    if (new URL(options.url).pathname !== `${root}/pullrequests/3`) return null;
    const response = { ...detail(3), source: { branch: { name: 'deleted-branch' } } };
    return { statusCode: 200, headers: {}, body: JSON.stringify(response) };
  };
  const result = await f.node.execute.call(f.context);
  assert.equal(result[0][0].json.retrieval.commit_prefixes_unchanged, false);
  assert.equal(result[0][0].json.pull_request.source.branch.name, 'deleted-branch');
});

test('handles API errors explicitly and supports Continue On Fail', async () => {
  const f = fixture();
  f.api.override = (options) => options.url.includes('/comments?') ? { statusCode: 403, body: '{}' } : null;
  await assert.rejects(f.node.execute.call(f.context), /HTTP 403/);
  f.context.continueOnFail = () => true;
  const result = await f.node.execute.call(f.context);
  assert.match(result[0][0].json.error, /HTTP 403/);
  assert.deepEqual(result[0][0].pairedItem, { item: 0 });
});

test('rejects invalid inputs before sending any requests', async () => {
  for (const [name, value] of [['workspace', '../bad'], ['repository', 'other/repo'], ['pullRequestId', 0], ['pullRequestId', '3abc']]) {
    const f = fixture();
    f.params[name] = value;
    await assert.rejects(f.node.execute.call(f.context));
    assert.deepEqual(f.calls, []);
  }
});
