# Stage 1: Build (runs as root — this stage is discarded)
FROM registry.access.redhat.com/ubi9/nodejs-20:latest AS build
USER 0
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Serve
FROM registry.access.redhat.com/ubi9/nginx-124:latest
COPY --from=build /build/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
