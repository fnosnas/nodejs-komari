FROM node:18-bookworm-slim

WORKDIR /app
COPY . .

RUN apt-get update && \
    apt-get install -y ca-certificates curl && \
    npm install --production && \
    rm -rf /var/lib/apt/lists/*

EXPOSE 3000
CMD ["node", "
