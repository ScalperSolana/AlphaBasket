FROM node:20-bookworm-slim

WORKDIR /app/settler-bot

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY settler-bot/package*.json ./
RUN npm install --legacy-peer-deps

COPY settler-bot/ ./

RUN npm run build

CMD ["npm", "start"]
