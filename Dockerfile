# Use a lightweight Node.js LTS runtime
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package management files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy application source files
COPY server.js ./
COPY public/ ./public/

# Inform Docker that the container listens on this port at runtime
EXPOSE 8080

# Run the Node.js server directly (Ensures OS signals like SIGTERM are caught properly)
CMD ["node", "server.js"]
