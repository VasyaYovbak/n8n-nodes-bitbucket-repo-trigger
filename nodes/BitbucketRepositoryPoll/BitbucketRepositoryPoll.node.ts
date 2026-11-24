import type { IDataObject, INodeExecutionData, INodeType, INodeTypeDescription, IPollFunctions } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const apiOrigin = 'https://api.bitbucket.org';
const maxPages = 100;

type Snapshot = { id: number; revision: string; pullrequest: IDataObject };
type CommentSnapshot = { id: number; mentioned: boolean; comment: IDataObject; updated: string };
type MentionConfig = { name: string; accountId: string; key: string };

const createdEvent = 'pullrequest:created';
const updatedEvent = 'pullrequest:updated';
const mentionEvent = 'pullrequest:comment:mention';
const allowedEvents = [createdEvent, updatedEvent, mentionEvent];

function slug(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid ${name}; enter the Bitbucket slug, not a URL`);
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// PR payloads from Bitbucket Cloud commonly contain 12-character commit prefixes.
// Normalize full and abbreviated representations of the same commit consistently.
function revisionKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hashes = /^([a-f0-9]{12,64}):([a-f0-9]{12,64})$/i.exec(value);
  return hashes ? `${hashes[1].slice(0, 12).toLowerCase()}:${hashes[2].slice(0, 12).toLowerCase()}` : null;
}

function snapshot(value: unknown): Snapshot {
  const pr = asObject(value);
  const source = asObject(asObject(pr?.source)?.commit)?.hash;
  const destination = asObject(asObject(pr?.destination)?.commit)?.hash;
  const revision = typeof source === 'string' && typeof destination === 'string' ? revisionKey(`${source}:${destination}`) : null;
  if (!pr || !Number.isSafeInteger(pr.id) || (pr.id as number) <= 0 || pr.state !== 'OPEN' || !revision) {
    throw new Error('Bitbucket returned an open PR without a valid ID and source/destination commits');
  }
  return { id: pr.id as number, revision, pullrequest: pr as IDataObject };
}

function nextPage(value: unknown, expectedPath: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid Bitbucket pagination URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Bitbucket pagination URL'); }
  if (url.origin !== apiOrigin || url.username || url.password || url.hash ||
      url.pathname.replace(/\/$/, '') !== expectedPath.replace(/\/$/, '')) {
    throw new Error('Bitbucket pagination URL is outside the selected repository');
  }
  return url.toString();
}

async function getOpenPullRequests(context: IPollFunctions, workspace: string, repository: string): Promise<Snapshot[]> {
  const path = `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}/pullrequests`;
  let url: string | null = `${apiOrigin}${path}?state=OPEN&pagelen=50`;
  const visited = new Set<string>();
  const found = new Map<number, Snapshot>();
  while (url) {
    if (visited.size >= maxPages || visited.has(url)) throw new Error('Bitbucket pagination exceeded the limit or repeated a page');
    visited.add(url);
    const response: unknown = await context.helpers.httpRequestWithAuthentication.call(context, 'bitbucketRepositoryToken', {
      method: 'GET', url, json: true, disableFollowRedirect: true, timeout: 15000,
    });
    const page = asObject(response);
    if (!page || !Array.isArray(page.values)) throw new Error('Bitbucket returned an invalid pull request list');
    for (const value of page.values) {
      const item = snapshot(value);
      const previous = found.get(item.id);
      if (previous && previous.revision !== item.revision) throw new Error(`PR #${item.id} changed while fetching pages; try again`);
      found.set(item.id, item);
    }
    url = nextPage(page.next, path);
  }
  return [...found.values()];
}

function mentionConfig(nameValue: unknown, accountValue: unknown): MentionConfig {
  if (typeof nameValue !== 'string' || typeof accountValue !== 'string') throw new Error('Invalid agent mention settings');
  const name = nameValue.trim().replace(/^@/, '');
  const accountId = accountValue.trim();
  if (name && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('Agent name must contain only letters, numbers, dots, underscores or hyphens');
  if (accountId && !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(accountId)) throw new Error('Invalid Atlassian account ID');
  if (!name && !accountId) throw new Error('Enter an agent name or Atlassian account ID for mention events');
  return { name: name.toLowerCase(), accountId, key: JSON.stringify([name.toLowerCase(), accountId]) };
}

function mentionsAgent(raw: string, config: MentionConfig): boolean {
  if (config.accountId && raw.includes(`@{${config.accountId}}`)) return true;
  if (!config.name) return false;
  const name = config.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_@.+-])@${name}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'iu').test(raw);
}

async function getComments(context: IPollFunctions, workspace: string, repository: string, id: number, config: MentionConfig): Promise<CommentSnapshot[]> {
  const path = `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}/pullrequests/${id}/comments`;
  let url: string | null = `${apiOrigin}${path}?pagelen=100`;
  const visited = new Set<string>();
  const found = new Map<number, CommentSnapshot>();
  while (url) {
    if (visited.size >= maxPages || visited.has(url)) throw new Error('Bitbucket comment pagination exceeded the limit or repeated a page');
    visited.add(url);
    const response: unknown = await context.helpers.httpRequestWithAuthentication.call(context, 'bitbucketRepositoryToken', {
      method: 'GET', url, json: true, disableFollowRedirect: true, timeout: 15000,
    });
    const page = asObject(response);
    if (!page || !Array.isArray(page.values)) throw new Error('Bitbucket returned an invalid comment list');
    for (const value of page.values) {
      const comment = asObject(value);
      if (!comment || !Number.isSafeInteger(comment.id) || (comment.id as number) <= 0) throw new Error('Bitbucket returned a comment without a valid ID');
      const raw = asObject(comment.content)?.raw;
      const active = comment.deleted !== true && comment.pending !== true;
      if (active && typeof raw !== 'string') throw new Error('Bitbucket returned a comment without raw content');
      const mentioned = active && mentionsAgent(raw as string, config);
      const updated = typeof comment.updated_on === 'string' ? comment.updated_on : '';
      if (mentioned && !updated) throw new Error('Bitbucket returned a matching comment without an update timestamp');
      const item: CommentSnapshot = { id: comment.id as number, mentioned, comment: comment as IDataObject, updated };
      const previous = found.get(item.id);
      if (previous && (previous.mentioned !== item.mentioned || previous.updated !== item.updated)) throw new Error(`Comment #${item.id} changed while fetching pages; try again`);
      found.set(item.id, item);
    }
    url = nextPage(page.next, path);
  }
  return [...found.values()];
}

function output(item: Snapshot, workspace: string, repository: string, event: string): IDataObject {
  return {
    event,
    revision_key: `${workspace}/${repository}#${item.id}:${item.revision}`,
    body: {
      pullrequest: item.pullrequest,
      repository: { full_name: `${workspace}/${repository}` },
    },
  };
}

export class BitbucketRepositoryPoll implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Bitbucket Repository PR Poll',
    name: 'bitbucketRepositoryPoll',
    icon: 'file:icon.svg',
    group: ['trigger'],
    version: 1,
    description: 'Periodically checks Bitbucket Cloud for pull requests, commit changes and agent mentions',
    defaults: { name: 'Bitbucket Repository PR Poll' },
    polling: true,
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'bitbucketRepositoryToken', required: true }],
    properties: [
      {
        displayName: 'Workspace Slug', name: 'workspace', type: 'string', required: true,
        default: '', placeholder: 'dashfin', description: 'The workspace slug from the repository URL',
      },
      {
        displayName: 'Repository Slug', name: 'repository', type: 'string', required: true,
        default: '', placeholder: 'test-repo', description: 'The repository slug from the Bitbucket URL',
      },
      {
        displayName: 'Include Existing PRs on First Run', name: 'includeExisting', type: 'boolean', default: false,
        description: 'Whether the first automatic poll emits all currently open PRs instead of only recording them',
      },
      {
        displayName: 'Events', name: 'events', type: 'multiOptions', required: true,
        options: [
          { name: 'Agent Mentioned in Comment', value: mentionEvent, description: 'A new mention or a mention added to an existing comment' },
          { name: 'Pull Request Created', value: createdEvent, description: 'A pull request appears in the open PR list' },
          { name: 'Pull Request Updated', value: updatedEvent, description: 'The source or destination commit changes' },
        ],
        default: [createdEvent, updatedEvent],
      },
      {
        displayName: 'Agent Name', name: 'agentName', type: 'string', default: '', placeholder: 'agent',
        displayOptions: { show: { events: [mentionEvent] } },
        description: 'Match a textual @name in a comment. Enter a name, an Atlassian account ID, or both.',
      },
      {
        displayName: 'Agent Atlassian Account ID', name: 'agentAccountId', type: 'string', default: '', placeholder: '712020:...',
        displayOptions: { show: { events: [mentionEvent] } },
        description: 'Match real Bitbucket account mentions by Atlassian account ID',
      },
    ],
  };

  async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
    const workspace = slug(this.getNodeParameter('workspace'), 'workspace');
    const repository = slug(this.getNodeParameter('repository'), 'repository');
    const events = this.getNodeParameter('events', [createdEvent, updatedEvent]);
    if (!Array.isArray(events) || !events.length || events.some((event) => typeof event !== 'string' || !allowedEvents.includes(event))) {
      throw new Error('Select at least one valid event');
    }
    const selected = new Set(events as string[]);
    const config = selected.has(mentionEvent)
      ? mentionConfig(this.getNodeParameter('agentName', ''), this.getNodeParameter('agentAccountId', ''))
      : null;
    const items = await getOpenPullRequests(this, workspace, repository);

    if (this.getMode() === 'manual') {
      return items.length ? [this.helpers.returnJsonArray([output(items[0], workspace, repository, 'poll:test')])] : null;
    }

    const state = this.getWorkflowStaticData('node');
    const repositoryKey = `${workspace.toLowerCase()}/${repository.toLowerCase()}`;
    const previous = state.repositoryKey === repositoryKey ? asObject(state.revisions) : null;
    if (state.repositoryKey === repositoryKey && state.revisions !== undefined && !previous) {
      throw new NodeOperationError(this.getNode(), 'The saved polling state is invalid; inspect the workflow before resetting it');
    }
    const includeExisting = this.getNodeParameter('includeExisting') === true;
    const next: Record<string, string> = {};
    const sameMentionConfig = config && state.repositoryKey === repositoryKey && state.mentionConfig === config.key;
    const previousComments = sameMentionConfig ? asObject(state.comments) : null;
    if (sameMentionConfig && !previousComments) throw new NodeOperationError(this.getNode(), 'The saved comment polling state is invalid; inspect the workflow before resetting it');
    const nextComments: Record<string, Record<string, boolean>> = {};
    const emitted: IDataObject[] = [];
    for (const item of items) {
      const key = String(item.id);
      next[key] = item.revision;
      if (!previous) {
        if (includeExisting && selected.has(createdEvent)) emitted.push(output(item, workspace, repository, createdEvent));
      } else if (!Object.hasOwn(previous, key)) {
        if (selected.has(createdEvent)) emitted.push(output(item, workspace, repository, createdEvent));
      } else {
        const savedRevision = revisionKey(previous[key]);
        if (!savedRevision) throw new NodeOperationError(this.getNode(), `The saved revision for PR #${item.id} is invalid; inspect the workflow before resetting it`);
        if (savedRevision !== item.revision && selected.has(updatedEvent)) emitted.push(output(item, workspace, repository, updatedEvent));
      }
      if (config) {
        const oldComments = previousComments && Object.hasOwn(previousComments, key) ? asObject(previousComments[key]) : null;
        if (previousComments && Object.hasOwn(previousComments, key) && !oldComments) throw new NodeOperationError(this.getNode(), `The saved comment state for PR #${item.id} is invalid; inspect the workflow before resetting it`);
        const comments = await getComments(this, workspace, repository, item.id, config);
        const commentState: Record<string, boolean> = {};
        for (const comment of comments) {
          const commentKey = String(comment.id);
          const oldMention = oldComments?.[commentKey];
          if (oldMention !== undefined && typeof oldMention !== 'boolean') throw new NodeOperationError(this.getNode(), `The saved state for comment #${comment.id} is invalid; inspect the workflow before resetting it`);
          commentState[commentKey] = comment.mentioned;
          // A newly enabled or changed mention configuration is baselined without replay.
          if (previousComments && comment.mentioned && oldMention !== true) {
            const event = output(item, workspace, repository, mentionEvent);
            const body = event.body as IDataObject;
            body.comment = comment.comment;
            event.event_key = `${workspace}/${repository}#${item.id}:comment:${comment.id}:${comment.updated}`;
            emitted.push(event);
          }
        }
        nextComments[key] = commentState;
      }
    }
    state.repositoryKey = repositoryKey;
    state.revisions = next;
    if (config) {
      state.mentionConfig = config.key;
      state.comments = nextComments;
    } else {
      delete state.mentionConfig;
      delete state.comments;
    }
    return emitted.length ? [this.helpers.returnJsonArray(emitted)] : null;
  }
}
