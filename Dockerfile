FROM public.ecr.aws/docker/library/node:22-alpine AS build

# Rust, for adblock-rs (app/src/filters.js), which compiles at install. rustup
# fetches the toolchain the package's rust-toolchain.toml pins. musl links
# statically by default, and a static build can't be the shared library Node
# loads, hence -crt-static.
RUN apk add --no-cache build-base rustup \
	&& rustup-init -y --profile minimal --default-toolchain none
ENV PATH="/root/.cargo/bin:$PATH" RUSTFLAGS="-C target-feature=-crt-static"

RUN npm install --global pnpm@10.28.0

WORKDIR /srv

COPY app ./app
# (Rust's build directory is 200 MB the runtime doesn't need)
RUN cd app && pnpm install --prod --frozen-lockfile \
	&& rm -rf node_modules/.pnpm/adblock-rs@*/node_modules/adblock-rs/target

# Runtime image: the app and its production dependencies, without pnpm or Rust.
FROM public.ecr.aws/docker/library/node:22-alpine

# Tor, for Tor tabs (app/src/tor.js; TOR=off switches them off)
RUN apk add --no-cache tor

WORKDIR /srv
COPY --from=build /srv/app ./app

# Railway sets PORT; the server falls back to 8787 when it is unset.
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "app/src/index.js"]
