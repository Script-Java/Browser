FROM node:25-alpine AS build

RUN npm install --global pnpm@10.28.0

WORKDIR /srv

COPY app ./app
RUN cd app && pnpm install --prod --frozen-lockfile

# Runtime image: the app and its production dependencies, without pnpm.
FROM node:25-alpine

# Tor, for Tor tabs (app/src/tor.js; TOR=off switches them off)
RUN apk add --no-cache tor

WORKDIR /srv
COPY --from=build /srv/app ./app

# Railway sets PORT; the server falls back to 8787 when it is unset.
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "app/src/index.js"]
