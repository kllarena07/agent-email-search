FROM node:20-alpine

RUN apk add --no-cache bash

RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json search-threads.ts search.sh ./

RUN pnpm install --frozen-lockfile

RUN pnpm build

CMD ["bash", "/app/search.sh"]
