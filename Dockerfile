FROM rust:1-alpine AS rust-build
WORKDIR /app
COPY apps/simulation-rust/Cargo.toml apps/simulation-rust/Cargo.lock ./
COPY apps/simulation-rust/src ./src
RUN cargo build --release --locked

FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/game-config/package.json packages/game-config/
COPY packages/protocol/package.json packages/protocol/
RUN npm install
COPY . .
COPY --from=rust-build /app/target/release/tile-dominion-simulation /app/apps/simulation-rust/target/release/tile-dominion-simulation
RUN npm run build -w @tile/server && npm run build -w @tile/client
CMD ["npm","run","start","-w","@tile/server"]
