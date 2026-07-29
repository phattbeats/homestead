FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV DATA_DIR=/data PORT=3080
VOLUME /data
EXPOSE 3080
CMD ["node", "server.js"]
