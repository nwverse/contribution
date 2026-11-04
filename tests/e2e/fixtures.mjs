// 公共夹具：读取测试数据、拦截外部请求、收集控制台报错（每个用例结束时断言为空）。
import fs from 'node:fs';
import { test as base, expect } from '@playwright/test';

export const BOARD = JSON.parse(fs.readFileSync(new URL('../fixtures/board.json', import.meta.url), 'utf8'));
export const LAST = BOARD.weeks.length - 1;
export const THIS_WEEK = BOARD.weeks[LAST].start;
export const weekValue = (p, start) => (p.weekly.find(([w]) => w === start) || [0, 0])[1];
export const mag = (x) => (Math.round((x || 0) * 10) / 10).toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const PAGES = [
  { file: 'index.html', id: 'c1', label: '本周' },
  { file: 'ranking.html', id: 'c2', label: '排行榜' },
  { file: 'profile.html', id: 'c3', label: '档案' },
  { file: 'hatchery.html', id: 'c4', label: '孵化台' },
  { file: 'pond.html', id: 'c5', label: '形态池' },
  { file: 'rules.html', id: 'rules', label: '规则' },
];

export const test = base.extend({
  // 外部请求（GitHub 头像）一律拦截：测试不依赖网络，头像回退为首字母
  external: [async ({ page }, use) => {
    const outside = [];
    await page.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === '127.0.0.1') return route.continue();
      outside.push(u.href);
      return route.abort();
    });
    await use(outside);
  }, { auto: true }],
  errors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await use(errors);
    expect(errors, '控制台不应有报错').toEqual([]);
  }, { auto: true }],
});

// 等页面脚本跑完：boot.js 去掉 is-booting，且顶栏已渲染
export async function open(page, path) {
  await page.goto(path);
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  await expect(page.locator('#appbar .brand')).toBeVisible();
}

export { expect };
