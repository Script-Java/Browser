FROM public.ecr.aws/docker/library/node:22-alpine AS build

RUN npm install --global pnpm@10.28.0

WORKDIR /srv

COPY app ./app
RUN cd app && pnpm install --prod --frozen-lockfile

# Runtime image: the app and its production dependencies, without pnpm.
FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /srv
COPY --from=build /srv/app ./app

# Railway sets PORT; the server falls back to 8787 when it is unset.
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "app/src/index.js"]
