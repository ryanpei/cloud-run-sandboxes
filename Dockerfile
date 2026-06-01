# Pull in statically linked tools (including shell required for Cloud Run SSH certificate logins)
FROM busybox:stable-musl as tools

# Use standard Node.js slim image for main execution runtime
FROM node:20-slim

# Install Python 3 inside the main container filesystem context!
# Because Cloud Run Sandbox clones your active container filesystem overlay for the guest VM,
# installing Python 3 here guarantees that it is natively present and executable inside the guest sandbox!
RUN apt-get update && apt-get install -y \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy dependency specifications
COPY package.json tsconfig.json ./

# Install packages
RUN npm install

# Copy raw TS agent source folder and gateway server script
COPY agents/ ./agents/
COPY server.ts ./

# Compile TypeScript to JavaScript (compiles all TS files to dist/ as standard CJS files!)
RUN npm run build

# Copy in statically linked busybox tools and install all commands under /bin
COPY --from=tools /bin/busybox /bin/busybox
SHELL ["/bin/busybox", "sh", "-c"]
RUN ["/bin/busybox", "--install", "/bin"]

# Replace or create the root user entry to allow Cloud Run OS Login mechanisms to authenticate
RUN sed -i '/^root:/c\root:x:0:0:root:/root:/bin/sh' /etc/passwd || echo 'root:x:0:0:root:/root:/bin/sh' >> /etc/passwd

# Expose HTTP port
EXPOSE 8080

# Configure execution server entrypoint wrapping our custom primary gateway
CMD ["npm", "start"]
