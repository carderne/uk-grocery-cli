FROM node:24-slim

WORKDIR /app

ENV GROC_API_HOST=0.0.0.0
ENV GROC_API_PORT=7876

COPY package*.json ./
RUN npm ci \
  && npx playwright install --with-deps chromium \
  && apt-get update \
  && apt-get install -y --no-install-recommends xvfb xauth \
  && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json ./
COPY src ./src

EXPOSE 7876
CMD ["sh", "-lc", "echo 'Starting groc API under Xvfb...' && xvfb-run -a --server-args='-screen 0 1280x800x24' npm run api"]
