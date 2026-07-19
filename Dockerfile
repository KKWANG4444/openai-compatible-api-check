FROM node:20-alpine

WORKDIR /opt/model-api-check
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY action/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
