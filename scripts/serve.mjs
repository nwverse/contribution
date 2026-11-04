#!/usr/bin/env node
// 本地预览：静态服务仓库根目录，用于手工走查与端到端测试。无第三方依赖。
// 用法：node scripts/serve.mjs [端口，默认 8080]
// data/board.json 依次取：环境变量 BOARD_FILE → 仓库里的 data/board.json → dist/board.json（upload.mjs --dry-run 的输出）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function boardFile() {
  const candidates = [process.env.BOARD_FILE, path.join(ROOT, 'data', 'board.json'), path.join(ROOT, 'dist', 'board.json')];
  return candidates.find((f) => f && fs.existsSync(f)) || null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file;
  if (url.pathname === '/data/board.json') {
    file = boardFile();
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('没有数据：先运行 node scripts/upload.mjs --dry-run 生成 dist/board.json，或用 BOARD_FILE 指定文件');
      return;
    }
  } else {
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    file = path.join(ROOT, path.normalize(rel));
    // 只允许读取仓库内的文件
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const src = boardFile();
  console.log(`http://127.0.0.1:${PORT}/  数据：${src ? path.relative(ROOT, src) || src : '无（见上方说明）'}`);
});
