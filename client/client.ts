import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';

// Extract the target API URL and local file inputs from command line arguments
const TARGET_URL: string = process.argv[2] || 'https://secure-coding-assistant-YOUR_PROJECT_NUMBER.us-west1.run.app';
const INPUT_FILE: string | undefined = process.argv[3];

let pythonCode = `
import math
import sys

print("==========================================")
print("1. GUEST VM SANDBOX VERIFICATION SUCCESS!")
print("==========================================")
print("Factorial of 10 is:", math.factorial(10))
print("Guest Python Version:", sys.version)
`;

// If a local python file path is supplied, read the file stream natively
if (INPUT_FILE) {
  try {
    const absolutePath = path.resolve(INPUT_FILE);
    console.log(`[Local Client] Reading custom script: ${absolutePath}`);
    pythonCode = fs.readFileSync(absolutePath, 'utf8');
  } catch (err) {
    console.error(`[Local Client ERROR] Failed to read script file:`, (err as Error).message);
    process.exit(1);
  }
}

console.log(`================================================================`);
console.log(`[Local Sandbox Client] Target API URL: ${TARGET_URL}/execute`);
console.log(`[Local Sandbox Client] Python payload script length: ${Buffer.byteLength(pythonCode)} bytes`);
console.log(`================================================================`);

const payload = JSON.stringify({ code: pythonCode });
const urlObj = new URL(`${TARGET_URL}/execute`);
const transport = urlObj.protocol === 'https:' ? https : http;

const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  'Content-Length': Buffer.byteLength(payload).toString()
};

// Auto-inject secure bearer authorization if dynamic token caching is set in workstation shell
const localToken = process.env.API_AUTH_TOKEN || '';
if (localToken) {
  headers['Authorization'] = `Bearer ${localToken}`;
  console.log(`[Local Client] Token discovered in local workspace environment. Injecting Bearer Authorization.`);
}

const req = transport.request({
  hostname: urlObj.hostname,
  port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
  path: urlObj.pathname,
  method: 'POST',
  headers: headers
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log(`[Server Response] HTTP Status: ${res.statusCode}`);
    try {
      const response = JSON.parse(body);
      
      console.log(`\n========================= GUEST STDOUT =========================`);
      console.log(response.stdout ? response.stdout.trim() : '(no stdout logs returned)');
      
      console.log(`========================= GUEST STDERR =========================`);
      console.log(response.stderr ? response.stderr.trim() : '(no stderr logs returned)');
      console.log(`================================================================\n`);
    } catch (e) {
      console.log(`[Response Body]`, body);
    }
  });
});

req.on('error', (e) => {
  console.error(`[Connection Error] Failed to reach target API:`, e.message);
});

req.write(payload);
req.end();
