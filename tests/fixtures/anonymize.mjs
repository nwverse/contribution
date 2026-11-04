#!/usr/bin/env node
// 由真实快照生成端到端测试数据：账号按名次换成 frog-01、frog-02…，数字保持不变。
// 用法：node tests/fixtures/anonymize.mjs dist/board.json > tests/fixtures/board.json
import fs from 'node:fs';

const src = process.argv[2];
if (!src) {
  console.error('用法：node tests/fixtures/anonymize.mjs <board.json>');
  process.exit(1);
}
const board = JSON.parse(fs.readFileSync(src, 'utf8'));
const width = String(board.people.length).length;
const names = new Map(board.people.map((p) => [p.login, `frog-${String(p.rank).padStart(width, '0')}`]));
for (const p of board.people) p.login = names.get(p.login);
let json = JSON.stringify(board);
// 兜底：任何地方残留的原账号名都视为错误
for (const login of names.keys()) {
  if (json.includes(`"${login}"`)) throw new Error(`账号名未替换干净：${login}`);
}
process.stdout.write(`${json}\n`);
