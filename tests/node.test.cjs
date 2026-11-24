const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { BitbucketRepositoryTrigger } = require('../dist/nodes/BitbucketRepositoryTrigger/BitbucketRepositoryTrigger.node.js');
const { BitbucketRepositoryToken } = require('../dist/credentials/BitbucketRepositoryToken.credentials.js');
const { normalizeHookId, verifySignature } = require('../dist/nodes/BitbucketRepositoryTrigger/security.js');

const id = '6fcf4e30-cdaa-4b0e-9c32-046b0ce21d23';
const secret = '3b89b1f2355c4a7e765170abce4e21f10e8214f356c4a93d286fc1ca64dacee4';
const hookUrl = 'https://n8n.example.org/webhook/test';
const activeEvents = ['pullrequest:created', 'pullrequest:updated'];

function fixture() {
  const node = new BitbucketRepositoryTrigger();
  const state = {};
  const settings = { workspace: 'dashfin', repository: 'test-repo', events: [...activeEvents] };
  const credentials = { accessToken: 'fake-access-token', webhookSecret: secret };
  const requests = [];
  const remote = { hook: null, error: null };
  const ctx = {
    getNode: () => ({ name: 'Test' }),
    getNodeParameter: (name) => settings[name],
    getNodeWebhookUrl: () => hookUrl,
    getCredentials: async () => credentials,
    getWorkflowStaticData: () => state,
    helpers: {
      httpRequestWithAuthentication: async (credentialType, options) => {
        requests.push({ credentialType, ...options });
        if (remote.error) throw remote.error;
        if (options.method === 'POST') {
          remote.hook = { uuid: `{${id}}`, url: options.body.url, active: true, events: options.body.events, secret_set: true };
          return remote.hook;
        }
        if (!remote.hook) throw { httpCode: '404' };
        if (options.method === 'GET') return remote.hook;
        if (options.method === 'DELETE') { remote.hook = null; return {}; }
        throw Error('unexpected request');
      },
      returnJsonArray: (items) => items.map((item) => ({ json: item })),
    },
  };
  return { node, state, settings, credentials, requests, remote, ctx };
}

test('credential uses bearer auth rather than user or email', () => {
  const credential = new BitbucketRepositoryToken();
  assert.equal(credential.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.accessToken}}');
  assert.deepEqual(credential.properties.map((item) => item.name), ['accessToken', 'webhookSecret']);
  assert.ok(credential.properties.every((item) => item.typeOptions.password));
});

test('matches the Bitbucket official HMAC test vector and rejects bad signatures', () => {
  const raw = Buffer.from('Hello World!');
  const signature = 'sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9';
  assert.equal(verifySignature("It's a Secret to Everybody", raw, signature), true);
  assert.equal(verifySignature("It's a Secret to Everybody", Buffer.from('Hello World?'), signature), false);
  assert.equal(verifySignature('wrong', raw, signature), false);
  assert.equal(verifySignature('wrong', raw, 'sha1=' + 'a'.repeat(64)), false);
  assert.equal(verifySignature('wrong', raw, 'sha256=' + 'x'.repeat(64)), false);
  assert.equal(verifySignature('wrong', {}, signature), false);
  assert.equal(verifySignature('wrong', undefined, signature), false);
});

test('accepts both UUID header formats but rejects invalid UUIDs', () => {
  assert.equal(normalizeHookId(`{${id.toUpperCase()}}`), id);
  assert.equal(normalizeHookId(id), id);
  assert.equal(normalizeHookId(`{${id}`), null);
  assert.equal(normalizeHookId('../not-an-id'), null);
});

test('creates, checks and removes only the tracked repository webhook', async () => {
  const { node, state, ctx, requests } = fixture();
  const hooks = node.webhookMethods.default;
  assert.equal(await hooks.checkExists.call(ctx), false);
  assert.equal(await hooks.create.call(ctx), true);
  assert.equal(state.hookId, id);
  assert.equal(await hooks.checkExists.call(ctx), true);
  assert.equal(await hooks.delete.call(ctx), true);
  assert.deepEqual(state, {});
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET', 'DELETE']);
  assert.ok(requests.every((request) => request.credentialType === 'bitbucketRepositoryToken'));
  assert.equal(requests[0].url, 'https://api.bitbucket.org/2.0/repositories/dashfin/test-repo/hooks');
  assert.equal(requests[0].body.secret, secret);
  assert.deepEqual(requests[0].body.events, activeEvents);
  assert.equal(requests[1].url, `${requests[0].url}/${id}`);
  assert.equal(requests[2].url, requests[1].url);
});

test('detects deleted remote hooks, but does not discard state on other API failures', async () => {
  const { node, state, ctx, remote } = fixture();
  const hooks = node.webhookMethods.default;
  await hooks.create.call(ctx);
  remote.error = { httpCode: '403' };
  await assert.rejects(hooks.checkExists.call(ctx));
  await assert.rejects(hooks.delete.call(ctx));
  assert.equal(state.hookId, id);
  remote.error = { httpCode: '404' };
  assert.equal(await hooks.checkExists.call(ctx), false);
  assert.deepEqual(state, {});
});

test('refuses to reuse a hook after changing repository, events or secret', async () => {
  for (const change of [
    (fixture) => { fixture.settings.repository = 'another'; },
    (fixture) => { fixture.settings.events = ['pullrequest:created']; },
    (fixture) => { fixture.credentials.webhookSecret = 'x'.repeat(64); },
  ]) {
    const f = fixture();
    await f.node.webhookMethods.default.create.call(f.ctx);
    change(f);
    await assert.rejects(f.node.webhookMethods.default.checkExists.call(f.ctx), /settings changed/i);
    assert.equal(f.requests.length, 1);
    await f.node.webhookMethods.default.delete.call(f.ctx);
    assert.match(f.requests[1].url, /dashfin\/test-repo\/hooks\//);
  }
});

test('detects externally changed or unsigned webhooks', async () => {
  const f = fixture();
  await f.node.webhookMethods.default.create.call(f.ctx);
  f.remote.hook.secret_set = false;
  await assert.rejects(f.node.webhookMethods.default.checkExists.call(f.ctx), /no longer matches/i);
  assert.equal(f.state.hookId, id);
});

test('does not lose track of a webhook when Bitbucket reports it as unsigned', async () => {
  const f = fixture();
  f.ctx.helpers.httpRequestWithAuthentication = async () => ({ uuid: `{${id}}`, active: true, secret_set: false });
  await assert.rejects(f.node.webhookMethods.default.create.call(f.ctx), /did not confirm/i);
  assert.equal(f.state.hookId, id);
});

test('rejects bad settings before making requests', async () => {
  for (const change of [
    (f) => { f.settings.workspace = '../other'; },
    (f) => { f.settings.repository = 'https://bitbucket.org/ws/repo'; },
    (f) => { f.settings.events = ['repo:push']; },
    (f) => { f.credentials.webhookSecret = 'short'; },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(f.node.webhookMethods.default.create.call(f.ctx));
    assert.deepEqual(f.requests, []);
  }
});

test('accepts a signed Bitbucket delivery and rejects tampered or unrelated deliveries', async () => {
  const f = fixture();
  await f.node.webhookMethods.default.create.call(f.ctx);
  const body = { pullrequest: { id: 3, title: 'Привіт' }, repository: { full_name: 'dashfin/test-repo' } };
  const raw = Buffer.from(JSON.stringify(body));
  const headers = {
    'x-hook-uuid': id,
    'x-event-key': 'pullrequest:created',
    'x-request-uuid': 'delivery-1',
    'x-hub-signature': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
  };
  let rejected = false;
  const ctx = {
    ...f.ctx,
    getHeaderData: () => headers,
    getBodyData: () => body,
    getRequestObject: () => ({ rawBody: raw }),
    getResponseObject: () => ({ status: (code) => { assert.equal(code, 401); rejected = true; return { send: () => ({ end: () => {} }) }; } }),
  };
  const valid = await f.node.webhook.call(ctx);
  assert.deepEqual(valid.workflowData[0][0].json, { event: 'pullrequest:created', delivery: 'delivery-1', body });
  assert.equal(rejected, false);
  headers['x-hub-signature'] = 'sha256=' + '0'.repeat(64);
  assert.deepEqual(await f.node.webhook.call(ctx), { noWebhookResponse: true });
  assert.equal(rejected, true);
  rejected = false;
  headers['x-hub-signature'] = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  headers['x-hook-uuid'] = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.deepEqual(await f.node.webhook.call(ctx), { noWebhookResponse: true });
  assert.equal(rejected, true);
  rejected = false;
  headers['x-hook-uuid'] = id;
  headers['x-event-key'] = 'repo:push';
  assert.deepEqual(await f.node.webhook.call(ctx), { noWebhookResponse: true });
  assert.equal(rejected, true);
  rejected = false;
  headers['x-event-key'] = 'pullrequest:created';
  ctx.getRequestObject = () => ({ rawBody: undefined });
  assert.deepEqual(await f.node.webhook.call(ctx), { noWebhookResponse: true });
  assert.equal(rejected, true);
});
