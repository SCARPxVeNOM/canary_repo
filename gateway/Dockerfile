# Canary's own tor-js gateway: EF's tor-js-gateway, built from a pinned commit.
#
#   docker build -t canary-gateway gateway/
#   docker run -d --name canary-gateway -p 12298:12298/udp \
#     -e ADVERTISE=<public ip> -v canary-gateway:/data canary-gateway
#   (KPS_PORT=<port> to listen elsewhere; map the same port: -p <port>:<port>/udp)
#
# The gateway is blind: it relays encrypted Tor cells to guard relays and
# serves the public directory snapshot. See gateway/README.md.

FROM rust:1.97-bookworm AS build
ARG TORJS_COMMIT=d9d9612d10d3775ff100b70e96a291718191d856
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      build-essential pkg-config libssl-dev libsqlite3-dev clang cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git init /src && cd /src \
    && git remote add origin https://github.com/ethereum/tor-js.git \
    && git fetch --depth 1 origin "$TORJS_COMMIT" && git checkout FETCH_HEAD \
    # The pinned toolchain file targets the reproducible WASM build; this image already has 1.97.
    && rm -f rust-toolchain.toml
WORKDIR /src
RUN cargo install --locked --path crates/tor-js-gateway --root /opt

FROM debian:bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libssl3 libsqlite3-0 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/bin/tor-js-gateway /usr/local/bin/tor-js-gateway
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# HOME=/data keeps the config, the KPS identity key and the directory cache on
# one volume. The key must survive restarts: it is the certhash in the address.
ENV HOME=/data RUST_LOG=warn
VOLUME /data
EXPOSE 12298/udp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
