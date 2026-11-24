import type {
  IDataObject,
  IHookFunctions,
  IHttpRequestMethods,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { normalizeHookId, settingsFingerprint, verifySignature } from './security';

const supportedEvents = [
  'pullrequest:created',
  'pullrequest:updated',
  'pullrequest:approved',
  'pullrequest:unapproved',
  'pullrequest:fulfilled',
  'pullrequest:rejected',
] as const;

type Settings = { workspace: string; repository: string; events: string[]; secret: string; url: string };

function slug(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value === '..') {
    throw new Error(`Invalid ${field}; enter the Bitbucket slug, not a URL`);
  }
  return value;
}

function eventsValue(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((event) => !supportedEvents.includes(event))) {
    throw new Error('Select at least one supported pull request event');
  }
  return [...new Set(value as string[])].sort();
}

async function settings(context: IHookFunctions): Promise<Settings> {
  const workspace = slug(context.getNodeParameter('workspace'), 'workspace');
  const repository = slug(context.getNodeParameter('repository'), 'repository');
  const events = eventsValue(context.getNodeParameter('events'));
  const credentials = await context.getCredentials('bitbucketRepositoryToken');
  const secret = credentials.webhookSecret;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new NodeOperationError(context.getNode(), 'Webhook signing secret must be at least 32 characters. Generate a random secret and store it in the credential.');
  }
  const url = context.getNodeWebhookUrl('default');
  if (!url) throw new NodeOperationError(context.getNode(), 'The n8n webhook URL is not available');
  return { workspace, repository, events, secret, url };
}

function hooksPath(workspace: string, repository: string, id?: string): string {
  const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}/hooks`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

async function api(context: IHookFunctions, method: IHttpRequestMethods, path: string, body?: IDataObject): Promise<IDataObject> {
  return await context.helpers.httpRequestWithAuthentication.call(context, 'bitbucketRepositoryToken', {
    method,
    url: `https://api.bitbucket.org/2.0${path}`,
    json: true,
    ...(body ? { body } : {}),
  }) as IDataObject;
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { httpCode?: string | number; statusCode?: number; response?: { statusCode?: number } };
  return Number(candidate.httpCode ?? candidate.statusCode ?? candidate.response?.statusCode) === 404;
}

function clearState(state: IDataObject): void {
  delete state.hookId;
  delete state.workspace;
  delete state.repository;
  delete state.fingerprint;
}

export class BitbucketRepositoryTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Bitbucket Repository PR Trigger',
    name: 'bitbucketRepositoryTrigger',
    icon: 'file:icon.svg',
    group: ['trigger'],
    version: 1,
    description: 'Starts a workflow for Bitbucket Cloud pull request events using a repository access token',
    defaults: { name: 'Bitbucket Repository PR Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'bitbucketRepositoryToken', required: true }],
    webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
    properties: [
      {
        displayName: 'Workspace Slug',
        name: 'workspace',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'dashfin',
        description: 'The workspace slug from the repository URL',
      },
      {
        displayName: 'Repository Slug',
        name: 'repository',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'test-repo',
        description: 'The repository slug from its Bitbucket URL',
      },
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        required: true,
        options: [
          { name: 'PR Approved', value: 'pullrequest:approved' },
          { name: 'PR Created', value: 'pullrequest:created' },
          { name: 'PR Declined', value: 'pullrequest:rejected' },
          { name: 'PR Merged', value: 'pullrequest:fulfilled' },
          { name: 'PR Unapproved', value: 'pullrequest:unapproved' },
          { name: 'PR Updated', value: 'pullrequest:updated' },
        ],
        default: ['pullrequest:created', 'pullrequest:updated'],
        description: 'Pull request events to subscribe to',
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const state = this.getWorkflowStaticData('node');
        if (state.hookId === undefined) return false;
        const id = normalizeHookId(state.hookId);
        if (!id) throw new NodeOperationError(this.getNode(), 'Stored webhook ID is invalid; inspect the workflow and repository webhook settings');
        const current = await settings(this);
        const fingerprint = settingsFingerprint(current.workspace, current.repository, current.url, current.events, current.secret);
        if (state.workspace !== current.workspace || state.repository !== current.repository || state.fingerprint !== fingerprint) {
          throw new NodeOperationError(this.getNode(), 'Webhook settings changed. Deactivate the workflow before editing the repository, events, URL, or signing secret.');
        }
        let remote: IDataObject;
        try {
          remote = await api(this, 'GET', hooksPath(current.workspace, current.repository, id));
        } catch (error) {
          if (!isMissing(error)) throw error;
          clearState(state);
          return false;
        }
        const remoteEvents = Array.isArray(remote.events) ? [...remote.events].sort() : [];
        if (normalizeHookId(remote.uuid) !== id || remote.active !== true || remote.url !== current.url || remote.secret_set !== true || JSON.stringify(remoteEvents) !== JSON.stringify(current.events)) {
          throw new NodeOperationError(this.getNode(), 'The Bitbucket webhook no longer matches this workflow. Deactivate the workflow and recreate the webhook.');
        }
        return true;
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const state = this.getWorkflowStaticData('node');
        if (state.hookId !== undefined) throw new NodeOperationError(this.getNode(), 'A webhook is already tracked for this node');
        const current = await settings(this);
        const result = await api(this, 'POST', hooksPath(current.workspace, current.repository), {
          description: 'n8n repository PR trigger',
          url: current.url,
          active: true,
          events: current.events,
          secret: current.secret,
        });
        const id = normalizeHookId(result.uuid);
        if (!id) throw new NodeOperationError(this.getNode(), 'Bitbucket did not return a valid webhook ID. Check the repository webhook settings for an untracked webhook.');
        state.hookId = id;
        state.workspace = current.workspace;
        state.repository = current.repository;
        state.fingerprint = settingsFingerprint(current.workspace, current.repository, current.url, current.events, current.secret);
        if (result.active !== true || result.secret_set !== true) {
          throw new NodeOperationError(this.getNode(), 'Bitbucket did not confirm an active signed webhook. Check and remove it in the repository webhook settings.');
        }
        return true;
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const state = this.getWorkflowStaticData('node');
        if (state.hookId === undefined) return true;
        const id = normalizeHookId(state.hookId);
        if (!id) throw new NodeOperationError(this.getNode(), 'Stored webhook ID is invalid; inspect the repository webhook settings');
        const workspace = slug(state.workspace, 'stored workspace');
        const repository = slug(state.repository, 'stored repository');
        try {
          await api(this, 'DELETE', hooksPath(workspace, repository, id));
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        clearState(state);
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const state = this.getWorkflowStaticData('node');
    const headers = this.getHeaderData();
    const credentials = await this.getCredentials('bitbucketRepositoryToken');
    const secret = credentials.webhookSecret;
    const request = this.getRequestObject();
    const id = normalizeHookId(state.hookId);
    const receivedId = normalizeHookId(headers['x-hook-uuid']);
    const event = headers['x-event-key'];
    const selected = eventsValue(this.getNodeParameter('events'));
    if (
      typeof secret !== 'string' || secret.length < 32 || !id || id !== receivedId ||
      typeof event !== 'string' || !selected.includes(event) ||
      !verifySignature(secret, request.rawBody, headers['x-hub-signature'])
    ) {
      this.getResponseObject().status(401).send('Unauthorized').end();
      return { noWebhookResponse: true };
    }
    return {
      workflowData: [this.helpers.returnJsonArray([{
        event,
        delivery: typeof headers['x-request-uuid'] === 'string' ? headers['x-request-uuid'] : '',
        body: this.getBodyData(),
      }])],
    };
  }
}
