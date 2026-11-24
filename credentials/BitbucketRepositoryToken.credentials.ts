import type { ICredentialType, INodeProperties, IAuthenticateGeneric } from 'n8n-workflow';

export class BitbucketRepositoryToken implements ICredentialType {
  name = 'bitbucketRepositoryToken';
  displayName = 'Bitbucket Repository Token';
  documentationUrl = 'https://support.atlassian.com/bitbucket-cloud/docs/using-access-tokens/';

  properties: INodeProperties[] = [
    {
      displayName: 'Repository Access Token',
      name: 'accessToken',
      type: 'string',
      typeOptions: { password: true },
      required: true,
      default: '',
    },
    {
      displayName: 'Webhook Signing Secret',
      name: 'webhookSecret',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'Only for the webhook trigger: a separate random secret used to sign and verify deliveries',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } },
  };
}
