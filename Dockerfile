FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATABASE_FILE=/data/vive-alto-campoo.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["npm", "start"]
