import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const apiOrigin = 'https://api.bitbucket.org';
const maxPages = 100;
const maxRedirects = 3;

type FullResponse = { statusCode?: unknown; headers?: unknown; body?: unknown };
type Allowed = (path: string) => boolean;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function slug(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid ${name}; enter the Bitbucket slug, not a URL`);
  }
  return value;
}

function pullRequestId(value: unknown): number {
  const id = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new Error('Pull request ID must be a positive integer');
  return id;
}

function cleanPath(path: string): string {
  return path.replace(/\/$/, '');
}

function validatedUrl(value: string, base: string, allowed: Allowed): URL {
  let url: URL;
  try { url = new URL(value, base); } catch { throw new Error('Invalid Bitbucket response URL'); }
  if (url.origin !== apiOrigin || url.username || url.password || url.hash || !allowed(url.pathname)) {
    throw new Error('Bitbucket returned a URL outside the requested repository resource');
  }
  return url;
}

function location(headers: unknown): string | undefined {
  const values = object(headers);
  if (!values) return undefined;
  for (const [key, value] of Object.entries(values)) {
    if (key.toLowerCase() === 'location' && typeof value === 'string') return value;
  }
  return undefined;
}

async function get(context: IExecuteFunctions, start: string, allowed: Allowed): Promise<{ body: unknown; url: URL }> {
  let url = validatedUrl(start, apiOrigin, allowed);
  const visited = new Set<string>();
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    if (visited.has(url.href)) throw new Error('Bitbucket returned a redirect loop');
    visited.add(url.href);
    const response = await context.helpers.httpRequestWithAuthentication.call(context, 'bitbucketRepositoryToken', {
      method: 'GET', url: url.href, json: false, encoding: 'text',
      disableFollowRedirect: true, returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 30000,
    }) as FullResponse;
    const status = response?.statusCode;
    if (typeof status !== 'number') throw new Error('Bitbucket returned an invalid HTTP response');
    if ([301, 302, 303, 307, 308].includes(status)) {
      const next = location(response.headers);
      if (!next) throw new Error('Bitbucket returned a redirect without a Location header');
      if (redirect === maxRedirects) throw new Error('Bitbucket exceeded the redirect limit');
      url = validatedUrl(next, url.href, allowed);
      continue;
    }
    if (status < 200 || status >= 300) throw new Error(`Bitbucket returned HTTP ${status} while retrieving PR data`);
    return { body: response.body, url };
  }
  throw new Error('Bitbucket exceeded the redirect limit');
}

function jsonObject(body: unknown): Record<string, unknown> {
  let value = body;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('Bitbucket returned invalid JSON'); }
  }
  const result = object(value);
  if (!result) throw new Error('Bitbucket returned an invalid JSON object');
  return result;
}

async function pages(context: IExecuteFunctions, start: string, allowed: Allowed): Promise<IDataObject[]> {
  let next: string | null = start;
  const visited = new Set<string>();
  const items: IDataObject[] = [];
  let pagePath: string | undefined;
  while (next) {
    if (visited.size >= maxPages || visited.has(next)) throw new Error('Bitbucket pagination exceeded the limit or repeated a page');
    visited.add(next);
    const response = await get(context, next, allowed);
    if (pagePath === undefined) pagePath = cleanPath(response.url.pathname);
    if (cleanPath(response.url.pathname) !== pagePath) throw new Error('Bitbucket pagination changed the requested resource');
    const body = jsonObject(response.body);
    if (!Array.isArray(body.values) || body.values.some((value) => !object(value))) throw new Error('Bitbucket returned an invalid paginated response');
    items.push(...body.values as IDataObject[]);
    if (body.next === undefined || body.next === null) next = null;
    else {
      if (typeof body.next !== 'string' || !body.next) throw new Error('Bitbucket returned an invalid pagination URL');
      next = validatedUrl(body.next, response.url.href, (path) => allowed(path) && cleanPath(path) === pagePath).href;
    }
  }
  return items;
}

function hash(pr: Record<string, unknown>, side: 'source' | 'destination'): string | null {
  const value = object(object(pr[side])?.commit)?.hash;
  return typeof value === 'string' && /^[a-f0-9]{12,64}$/i.test(value) ? value.toLowerCase() : null;
}

function matchesCommit(before: string, after: string): boolean {
  return before.length <= after.length ? after.startsWith(before) : before.startsWith(after);
}

async function getContext(context: IExecuteFunctions, workspace: string, repository: string, id: number): Promise<IDataObject> {
  const root = `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}`;
  const prPath = `${root}/pullrequests/${id}`;
  const exact = (expected: string): Allowed => (path) => cleanPath(path) === expected;
  const diffPath = `${prPath}/diff`;
  const diffstatPath = `${prPath}/diffstat`;
  const diffAllowed: Allowed = (path) => cleanPath(path) === diffPath || path.startsWith(`${root}/diff/`);
  const diffstatAllowed: Allowed = (path) => cleanPath(path) === diffstatPath || path.startsWith(`${root}/diffstat/`);

  const first = jsonObject((await get(context, `${apiOrigin}${prPath}`, exact(prPath))).body);
  if (first.id !== id) throw new Error('Bitbucket returned a different pull request');

  const [diffResponse, comments, commits, changedFiles] = await Promise.all([
    get(context, `${apiOrigin}${diffPath}`, diffAllowed),
    pages(context, `${apiOrigin}${prPath}/comments?pagelen=100`, exact(`${prPath}/comments`)),
    pages(context, `${apiOrigin}${prPath}/commits?pagelen=100`, exact(`${prPath}/commits`)),
    pages(context, `${apiOrigin}${diffstatPath}?pagelen=100`, diffstatAllowed),
  ]);
  const diff = Buffer.isBuffer(diffResponse.body) ? diffResponse.body.toString('utf8') : diffResponse.body;
  if (typeof diff !== 'string') throw new Error('Bitbucket returned an invalid PR diff');

  const last = jsonObject((await get(context, `${apiOrigin}${prPath}`, exact(prPath))).body);
  if (last.id !== id) throw new Error('Bitbucket returned a different pull request');
  const sourceBefore = hash(first, 'source');
  const sourceAfter = hash(last, 'source');
  const destinationBefore = hash(first, 'destination');
  const destinationAfter = hash(last, 'destination');
  if (first.state !== last.state || (sourceBefore && sourceAfter && !matchesCommit(sourceBefore, sourceAfter)) ||
      (destinationBefore && destinationAfter && !matchesCommit(destinationBefore, destinationAfter))) {
    throw new Error('The pull request changed while its context was being fetched; try again');
  }
  return {
    pull_request: first as IDataObject,
    diff,
    comments,
    commits,
    changed_files: changedFiles,
    retrieval: { commit_prefixes_unchanged: !!(sourceBefore && sourceAfter && destinationBefore && destinationAfter) },
  };
}

export class BitbucketRepository implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Bitbucket Repository',
    name: 'bitbucketRepository',
    icon: 'file:icon.svg',
    group: ['transform'],
    version: 1,
    description: 'Read pull request context from Bitbucket Cloud',
    defaults: { name: 'Bitbucket Repository' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'bitbucketRepositoryToken', required: true }],
    properties: [
      {
        displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true,
        options: [{ name: 'Pull Request', value: 'pullRequest' }], default: 'pullRequest',
      },
      {
        displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true,
        options: [{ name: 'Get Context', value: 'getContext', action: 'Get pull request context', description: 'Get PR details, diff, comments, commits and changed files' }],
        default: 'getContext',
      },
      {
        displayName: 'Workspace Slug', name: 'workspace', type: 'string', required: true,
        default: '', placeholder: 'dashfin', description: 'The workspace slug from the repository URL',
      },
      {
        displayName: 'Repository Slug', name: 'repository', type: 'string', required: true,
        default: '', placeholder: 'test-repo', description: 'The repository slug from the Bitbucket URL',
      },
      {
        displayName: 'Pull Request ID', name: 'pullRequestId', type: 'number', required: true,
        default: 0, typeOptions: { minValue: 1 }, description: 'The numeric pull request ID',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const input = this.getInputData();
    const output: INodeExecutionData[] = [];
    for (let i = 0; i < input.length; i++) {
      try {
        const resource = this.getNodeParameter('resource', i);
        const operation = this.getNodeParameter('operation', i);
        if (resource !== 'pullRequest' || operation !== 'getContext') throw new Error('Unsupported resource or operation');
        const workspace = slug(this.getNodeParameter('workspace', i), 'workspace');
        const repository = slug(this.getNodeParameter('repository', i), 'repository');
        const id = pullRequestId(this.getNodeParameter('pullRequestId', i));
        output.push({ json: await getContext(this, workspace, repository, id), pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          output.push({ json: { error: error instanceof Error ? error.message : 'Unknown error' }, pairedItem: { item: i } });
          continue;
        }
        throw new NodeOperationError(this.getNode(), error instanceof Error ? error : new Error('Unknown error'), { itemIndex: i });
      }
    }
    return [output];
  }
}
