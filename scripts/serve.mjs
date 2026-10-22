import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);
const sourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const rootDirectory = await realpath(sourceDirectory);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

function isOutsideRoot(filePath) {
  const localPath = relative(rootDirectory, filePath);
  return localPath === '..' || localPath.startsWith(`..${sep}`) || isAbsolute(localPath);
}

function reply(request, response, status, message, extraHeaders = {}) {
  const body = `${message}\n`;
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    reply(request, response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }

  let decodedPath;
  try {
    // Decode before resolving so encoded traversal receives the same checks.
    decodedPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
  } catch {
    reply(request, response, 400, 'Malformed URL');
    return;
  }

  if (!decodedPath.startsWith('/') || /[\\\0:]/u.test(decodedPath)) {
    reply(request, response, 400, 'Invalid path');
    return;
  }

  const filePath = resolve(rootDirectory, decodedPath === '/' ? 'index.html' : `.${decodedPath}`);
  if (isOutsideRoot(filePath)) {
    reply(request, response, 403, 'Forbidden');
    return;
  }

  try {
    // Symlinks inside dist must not expose files outside the served directory.
    const canonicalPath = await realpath(filePath);
    if (isOutsideRoot(canonicalPath)) {
      reply(request, response, 403, 'Forbidden');
      return;
    }
    const fileInfo = await stat(canonicalPath);
    if (!fileInfo.isFile()) {
      reply(request, response, 404, 'Not found');
      return;
    }

    const body = request.method === 'HEAD' ? undefined : await readFile(canonicalPath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(canonicalPath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': fileInfo.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      reply(request, response, 404, 'Not found');
    } else if (error.code === 'EACCES' || error.code === 'EPERM') {
      reply(request, response, 403, 'Forbidden');
    } else {
      console.error('Could not serve the requested file:', error.code ?? error.name);
      reply(request, response, 500, 'Internal server error');
    }
  }
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Set PORT to use another port.`
    : `Server could not start: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Balance Lab: http://${host}:${port}`);
  console.log('Serving dist only. Press Ctrl+C to stop.');
});
