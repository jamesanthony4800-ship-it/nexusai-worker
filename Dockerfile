FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY worker.js .
COPY package.json .

CMD ["node", "worker.js"]
