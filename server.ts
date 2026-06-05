import * as http from 'http';
import * as net from 'net';
import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import dns from 'dns';

const PORT = 8080;
const ADK_PORT = 8081;

// Read the secure access token from environment variables (defaults to empty/disabled if not set)
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || '';

// Startup Debug Tests
console.log('[Gateway Startup Test] Starting DNS tests...');
dns.resolve('google.com', (err, addresses) => {
  console.log('[Gateway Startup Test] DNS google.com:', err ? err.message : addresses);
});
dns.resolve('us-west1-aiplatform.googleapis.com', (err, addresses) => {
  console.log('[Gateway Startup Test] DNS Vertex AI:', err ? err.message : addresses);
});

if (API_AUTH_TOKEN) {
  console.log(`[Gateway Security] Token Authentication ACTIVE. Gateway locked behind token boundaries.`);
} else {
  console.log(`[Gateway Security] WARNING: No API_AUTH_TOKEN set. Gateway operates in unauthenticated mode.`);
}

// 1. Spawning the background ADK DevTools Web UI Server on Port 8081 immediately
console.log(`[Gateway Startup] Launching background ADK Web Server on Port ${ADK_PORT}...`);
const adkProcess = spawn(process.argv[0], [
  './node_modules/@google/adk-devtools/dist/cli/cli.cjs',
  'web',
  './dist/agents',
  '--port',
  ADK_PORT.toString(),
  '--host',
  '127.0.0.1',
  '--allow_origins',
  "'*'"
], {
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

adkProcess.stdout?.on('data', (data) => {
  console.log(`[ADK STDOUT] ${data.toString().trim()}`);
});

adkProcess.stderr?.on('data', (data) => {
  console.error(`[ADK STDERR] ${data.toString().trim()}`);
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

  const urlObj = new URL(req.url || '', 'http://localhost');
  const queryToken = urlObj.searchParams.get('token');

  // Intercept the Direct Execute REST API Route
  if (urlObj.pathname === '/execute' && req.method === 'POST') {
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

  // Debug Endpoint: ps
  if (urlObj.pathname === '/debug/ps' && req.method === 'GET') {
    console.log(`[Debug Exec] Running command: ps aux`);
    exec('ps aux', (e, stdout, stderr) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`STDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    });
    return;
  }

  // Debug Endpoint: netstat
  if (urlObj.pathname === '/debug/netstat' && req.method === 'GET') {
    console.log(`[Debug Exec] Running command: netstat -an`);
    exec('netstat -an', (e, stdout, stderr) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`STDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    });
    return;
  }

  // Debug Endpoint: adk-log
  if (urlObj.pathname === '/debug/adk-log' && req.method === 'GET') {
    console.log(`[Debug Exec] Reading log: /tmp/adk.log`);
    try {
      const content = fs.readFileSync('/tmp/adk.log', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to read log: ${(err as Error).message}`);
    }
    return;
  }

  // Debug Endpoint: exec
  if (urlObj.pathname === '/debug/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const cmd = payload.command || '';
        console.log(`[Debug Exec] Running command: ${cmd}`);
        exec(cmd, (e, stdout, stderr) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(`STDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        });
      } catch (err) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

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
    const err = e as any;
    if (err.code === 'ECONNREFUSED') {
      console.log(`[Gateway Proxy] ADK server not ready yet on port ${ADK_PORT}. Serving loading page.`);
      
      // Check if the client expects HTML (browser page load)
      const acceptHeader = req.headers.accept || '';
      if (acceptHeader.includes('text/html') || req.url === '/' || req.url?.startsWith('/dev-ui')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getLoadingHtml());
        return;
      }

      // Otherwise, return a clean JSON response for API clients
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      res.end(JSON.stringify({
        status: 'starting',
        message: 'Sandbox assistant is booting up. Please retry in a few seconds.'
      }));
      return;
    }

    console.error(`[Gateway Proxy HTTP Error]`, e);
    res.writeHead(502);
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq, { end: true });
});

// HTML Loading Template served during cold-start boot sequence
function getLoadingHtml(): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Starting Sandbox Assistant...</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: 'Google Sans', 'Segoe UI', Arial, sans-serif;
      background-color: #131314;
      color: #e5e2e2;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .container {
      text-align: center;
      max-width: 400px;
      padding: 20px;
    }
    .spinner {
      border: 4px solid rgba(255, 255, 255, 0.1);
      width: 50px;
      height: 50px;
      border-radius: 50%;
      border-left-color: #8ab4f8;
      animation: spin 1s linear infinite;
      margin: 0 auto 24px auto;
    }
    h1 {
      font-size: 22px;
      font-weight: 400;
      margin: 0 0 16px 0;
      color: #ffffff;
      letter-spacing: -0.5px;
    }
    p {
      font-size: 14px;
      color: #9e9e9e;
      line-height: 1.6;
      margin: 0 0 28px 0;
    }
    .status {
      font-size: 12px;
      color: #8ab4f8;
      background-color: rgba(138, 180, 248, 0.08);
      padding: 8px 18px;
      border-radius: 20px;
      display: inline-block;
      border: 1px solid rgba(138, 180, 248, 0.15);
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
  <script>
    // Automatically check back by reloading the page every 2 seconds
    setTimeout(() => {
      window.location.reload();
    }, 2000);
  </script>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h1>Starting Sandbox Assistant</h1>
    <p>We are provisioning your secure, sandboxed execution environment. This will only take a few seconds.</p>
    <div class="status">Booting environment...</div>
  </div>
</body>
</html>
  `;
}


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
