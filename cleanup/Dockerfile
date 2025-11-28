FROM node:18-alpine
ENV NODE_ENV=production

# Install docker CLI and docker-compose plugin
RUN apk add --no-cache docker-cli docker-compose curl

WORKDIR /app

COPY ["package.json", "package-lock.json*", "./"]

RUN npm install --production

COPY . .

CMD [ "npm", "start" ]

