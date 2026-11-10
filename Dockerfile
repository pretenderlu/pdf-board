# PDF 摘录白板 · 容器镜像
# 构建：  docker compose build      （或 docker build -t pdf-board .）
# 运行：  docker compose up -d
FROM node:22-alpine

WORKDIR /app

# 只拷贝运行所需文件；数据目录由卷挂载，不打进镜像
COPY index.html server.mjs ./
COPY js ./js
COPY css ./css
COPY vendor ./vendor
COPY README.md ./

ENV PDFBOARD_HOST=0.0.0.0 \
    PDFBOARD_DATA=/data \
    PDFBOARD_NO_OPEN=1 \
    PORT=7420

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 7420

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7420/__health >/dev/null 2>&1 || exit 1

CMD ["node", "server.mjs"]
