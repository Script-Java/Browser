FROM node:22-alpine

RUN npm install --global pnpm@10

WORKDIR /srv

COPY Ultraviolet ./Ultraviolet
RUN cd Ultraviolet && pnpm install --no-frozen-lockfile && pnpm build

COPY app ./app
RUN cd app && pnpm install --prod

# Railway sets PORT; the server falls back to 8787 when it is unset.
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "app/src/index.js"]
