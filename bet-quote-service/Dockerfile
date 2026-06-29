FROM node:20-bookworm-slim

WORKDIR /app/bet-quote-service

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY bet-quote-service/package*.json ./
RUN npm ci

COPY bet-quote-service/ ./

RUN npm run build

CMD ["npm", "start"]
