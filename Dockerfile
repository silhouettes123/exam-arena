# 零依赖镜像：不需要 npm install
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

# 题库与成绩写在这里；生产环境建议挂载卷
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
