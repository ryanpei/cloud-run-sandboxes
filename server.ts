import * as http from 'http';
import * as net from 'net';
import { exec, spawn } from 'child_process';

const PORT = 8080;
const ADK_PORT = 8081;

// Read the secure access token from environment variables (defaults to empty/disabled if not set)
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || '';

if (API_AUTH_TOKEN) {
  console.log(`[Gateway Security] Token Authentication ACTIVE. Gateway locked behind token boundaries.`);
} else {
  console.log(`[Gateway Security] WARNING: No API_AUTH_TOKEN set. Gateway operates in unauthenticated mode.`);
}

// 1. Spawning the background ADK DevTools Web UI Server on Port 8081
console.log(`[Gateway Startup] Launching background ADK Web Server on Port ${ADK_PORT}...`);
const adkProcess = spawn('npx', [
  'adk',
  'web',
  './dist/agents',
  '--port',
  ADK_PORT.toString(),
  '--host',
  '127.0.0.1',
  '--allow_origins',
  '*'
], {
  shell: true,
  stdio: 'inherit'
});

adkProcess.on('error', (err) => {
  console.error('[Gateway ERROR] Failed to start background ADK server:', err);
});

// Helper: Parse cookie header string into key-value pairs
function parseCookies(cookieStr: string): { [key: string]: string } {
  const list: { [key: string]: string } = {};
  if (!cookieStr) return list;
  cookieStr.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const key = parts.shift();
    if (key) {
      list[key.trim()] = decodeURI(parts.join('='));
    }
  });
  return list;
}

// Core Verification Logic: Checks Bearer headers, query params, and HttpOnly session cookies!
function isAuthenticated(req: http.IncomingMessage): boolean {
  // If there is no secret auth token defined inside container environments, bypass checks
  if (!API_AUTH_TOKEN) return true;

  // 1. Check standard Authorization Bearer header (Optimized for CLI client scripts!)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token === API_AUTH_TOKEN) return true;
  }

  // Parse target URL routing queries
  const urlObj = new URL(req.url || '', 'http://localhost');

  // 2. Check URL Query Parameters string (Optimized for the initial browser page load!)
  const queryToken = urlObj.searchParams.get('token');
  if (queryToken === API_AUTH_TOKEN) return true;

  // 3. Check for dynamic Session token inside HTTP-Only Cookies (Optimized for dynamic AJAX & WebSockets!)
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies.session_token === API_AUTH_TOKEN) return true;

  return false;
}

// 2. Initializing the Primary Gateway Server on Port 8080
const server = http.createServer((req, res) => {
  // Enforce CORS parameters so workstation client CLI suites can access the gateway natively
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Security Interceptor: Rejects unauthenticated traffic instantly
  if (!isAuthenticated(req)) {
    console.log(`[Gateway Guardrail] Blocked unauthenticated connection request targeting: ${req.url}`);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized. Missing or invalid access token.' }));
    return;
  }

  // Intercept the Direct Execute REST API Route
  if (req.url === '/execute' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const code = payload.code || '';
        
        // Escape quotes exactly as specified by the user's design block!
        const untrustedCode = code.replace(/"/g, '\\"');
        
        // Explicitly targets guest VM python3 path to bypass PATH constraints
        const cmd = `/usr/local/gcp/bin/sandbox do -- /usr/bin/python3 -c "${untrustedCode}"`;
        console.log(`[Direct Execute Trigger] Executing sandboxed python command...`);

        exec(cmd, (e, stdout, stderr) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            stdout: stdout.toString(), 
            stderr: stderr.toString() 
          }));
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload structure' }));
      }
    });
    return;
  }

  // Extract query parameters to inject cookies on dynamic UI page loads
  const urlObj = new URL(req.url || '', 'http://localhost');
  const queryToken = urlObj.searchParams.get('token');

  // Proxy standard HTTP/2 traffic straight to the background ADK DevTools server
  const proxyReq = http.request({
    host: '127.0.0.1',
    port: ADK_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers
  }, (proxyRes) => {
    // Copy the downstream server response headers
    const headers = { ...proxyRes.headers };
    
    // If the browser authenticated successfully using a query token on this load,
    // dynamically inject a secure, HTTP-Only session cookie!
    // This allows subsequent AJAX and WebSocket handshakes to authorize automatically.
    if (API_AUTH_TOKEN && queryToken === API_AUTH_TOKEN) {
      headers['set-cookie'] = [`session_token=${API_AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Secure`];
    }

    res.writeHead(proxyRes.statusCode || 200, headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (e) => {
    console.error(`[Gateway Proxy HTTP Error]`, e);
    res.writeHead(502);
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq, { end: true });
});

// 3. Native WebSocket Proxying Tunnel
// Intercepts connection upgrades on port 8080 and tunnels TCP socket streams straight to port 8081,
// completely bypassing GFE browser interface drops and network proxy blocks!
server.on('upgrade', (req, socket, head) => {
  // Security Interceptor: Rejects unauthenticated WebSocket handshake attempts instantly
  if (!isAuthenticated(req)) {
    console.log(`[Gateway Guardrail] Blocked unauthenticated WebSocket upgrade handshake targeting: ${req.url}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.end();
    return;
  }

  console.log(`[Gateway Proxy WebSocket Upgrade] Tunneling TCP connection upgrade: ${req.url}`);
  
  const client = net.connect(ADK_PORT, '127.0.0.1', () => {
    // Construct and forward the raw initial WebSocket handshake request string
    let rawHeaders = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      rawHeaders += `${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`;
    }
    rawHeaders += '\r\n';
    
    client.write(rawHeaders);
    client.write(head);
    
    // Establish a direct bidirectional pipe between the incoming socket and ADK's target port
    socket.pipe(client);
    client.pipe(socket);
  });
  
  client.on('error', (e) => {
    console.error(`[Gateway Proxy WebSocket Error]`, e);
    socket.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`+-------------------------------------------------------------+`);
  console.log(`| Primary Serverless Sandbox Gateway listening on Port ${PORT}  |`);
  console.log(`+-------------------------------------------------------------+`);
});
