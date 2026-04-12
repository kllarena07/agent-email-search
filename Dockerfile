FROM node:20-alpine

RUN apk add --no-cache bash

RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

CMD ["bash", "/app/start.sh"]