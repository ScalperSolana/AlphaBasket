FROM node:20-bookworm-slim

WORKDIR /app/indexer

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY indexer/package*.json ./
RUN npm install --legacy-peer-deps

COPY indexer/ ./
COPY program/ ../program/
COPY bet-lane/ ../bet-lane/
COPY bet-token/ ../bet-token/
COPY daily-contest/ ../daily-contest/

RUN npm run build

CMD ["npm", "run", "processor"]
