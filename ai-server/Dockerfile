FROM node:20-alpine AS build
WORKDIR /app/ai-server
COPY ai-server/package*.json ./
RUN npm ci
COPY ai-server/ ./
COPY src/lib/solana/idl/polybaskets_escrow.json /app/src/lib/solana/idl/polybaskets_escrow.json
RUN npm run build

FROM node:20-alpine
WORKDIR /app/ai-server
ENV NODE_ENV=production
COPY --from=build /app/ai-server/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/ai-server/dist ./dist
COPY --from=build /app/src /app/src
EXPOSE 4370
CMD ["node", "dist/http.js"]
