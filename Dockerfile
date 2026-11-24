ARG N8N_VERSION=2.46.6
FROM n8nio/n8n:${N8N_VERSION}

ENV N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom
ENV NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules

COPY --chown=node:node dist/ /opt/n8n-custom/
USER node
