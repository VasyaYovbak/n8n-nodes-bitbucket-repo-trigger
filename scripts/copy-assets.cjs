const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const destination = join('dist', 'nodes', 'BitbucketRepositoryTrigger');
mkdirSync(destination, { recursive: true });
copyFileSync(join('nodes', 'BitbucketRepositoryTrigger', 'icon.svg'), join(destination, 'icon.svg'));
const pollingDestination = join('dist', 'nodes', 'BitbucketRepositoryPoll');
mkdirSync(pollingDestination, { recursive: true });
copyFileSync(join('nodes', 'BitbucketRepositoryTrigger', 'icon.svg'), join(pollingDestination, 'icon.svg'));
const actionDestination = join('dist', 'nodes', 'BitbucketRepository');
mkdirSync(actionDestination, { recursive: true });
copyFileSync(join('nodes', 'BitbucketRepositoryTrigger', 'icon.svg'), join(actionDestination, 'icon.svg'));
