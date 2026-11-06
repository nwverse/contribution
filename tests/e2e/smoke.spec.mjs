// 六个页面都能启动：无报错、导航正确、启动无布局偏移、主题参数生效、只请求本站资源、启动脚本与数据并行下载；K.flip 跳过屏外的动画。
import { test, expect, open, PAGES, NAV } from './fixtures.mjs';

for (const pg of PAGES) {
  test(`${pg.label}页能加载 @mobile`, async ({ page, external, isMobile }) => {
    await open(page, `/${pg.file}`);
    await expect(page.locator('.boot-error')).toHaveCount(0);
    await expect(page.locator('h1, h2').first()).not.toBeEmpty();
    // 桌面看顶栏，手机看底部标签栏；当前页高亮
    const nav = isMobile ? page.locator('.tabbar') : page.locator('#appbar .nav');
    await expect(nav).toBeVisible();
    await expect(nav.locator('a')).toHaveCount(NAV.length);
    for (const other of NAV) await expect(nav.locator(`a[data-screen="${other.id}"]`)).toHaveAttribute('href', other.file);
    if (pg.nav === false) await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);
    else await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('data-screen', pg.id);
    // 外部请求只允许 GitHub 头像（已被拦截）；不允许调用 GitHub API
    expect(external.filter((u) => !/^https:\/\/github\.com\/[^/]+\.png/.test(u))).toEqual([]);
  });
}

// 启动期间顶栏占住高度、正文隐藏到页面脚本填好再显示，所以首屏没有布局偏移（CLS 按 web-vitals 口径应低于 0.1）
for (const pg of PAGES) {
  test(`${pg.label}页启动时没有布局偏移 @mobile`, async ({ page }) => {
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await open(page, `/${pg.file}`);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await page.evaluate(() => window.__cls)).toBeLessThan(0.1);
  });
}

test('页面滚动后顶栏显示底部分隔线', async ({ page }) => {
  await open(page, '/index.html');
  const bar = page.locator('#appbar');
  const color = () => bar.evaluate((el) => getComputedStyle(el).borderBottomColor);
  await expect.poll(color).toBe('rgba(0, 0, 0, 0)');
  await page.evaluate(() => scrollTo(0, 400));
  await expect(bar).toHaveClass(/is-scrolled/);
  await expect.poll(color).not.toBe('rgba(0, 0, 0, 0)');
});

test('?theme=dark 切到暗色，导航时保留', async ({ page }) => {
  await open(page, '/index.html?theme=dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#appbar .nav a[data-screen="c2"]').click();
  await expect(page).toHaveURL(/ranking\.html\?theme=dark/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

// 正文里手写的站内链接（不经顶栏拼接）也带上 ?theme，并保留链接自己的参数和锚点
const CONTENT_LINKS = [
  { from: '/index.html?theme=dark', link: '#boardLink', to: /ranking\.html\?win=week&theme=dark$/ },
  { from: '/index.html?theme=dark', link: '.lag-links a', to: /ranking\.html\?flag=(lag|watch)&theme=dark$/ },
  { from: '/index.html?theme=dark', link: '#lagFoot a[href^="rules.html"]', to: /rules\.html\?theme=dark#vitality$/ },
  { from: '/rules.html?theme=dark', link: '.vt-now a', to: /ranking\.html\?flag=(lag|watch)&theme=dark$/ },
  { from: '/ranking.html?theme=dark', link: '#gloss a[href^="rules.html"]', to: /rules\.html\?theme=dark#vitality$/ },
  { from: '/profile.html?theme=dark#u=frog-03', link: '.drawer a[href^="rules.html"]', to: /rules\.html\?theme=dark#vitality$/ },
];
for (const c of CONTENT_LINKS) {
  test(`正文链接带上 ?theme：${c.from} ${c.link}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, c.from);
    await page.locator(c.link).first().click();
    await expect(page).toHaveURL(c.to);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
}

test('正文链接在 ?theme=dark 下切到白天后带上新主题', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page, '/index.html?theme=dark');
  await page.locator('#appbar [data-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#boardLink').click();
  await expect(page).toHaveURL(/ranking\.html\?win=week&theme=light$/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('没有 ?theme 时正文链接保持原样', async ({ page }) => {
  await open(page, '/index.html');
  await page.locator('#boardLink').click();
  await expect(page).toHaveURL(/ranking\.html\?win=week$/);
});

const THEME_KEY = 'nwverse:contribution:theme';
for (const scheme of ['light', 'dark']) {
  const other = scheme === 'dark' ? 'light' : 'dark';
  test(`系统${scheme === 'dark' ? '深色' : '浅色'}下切换主题，经顶栏换页、刷新后保持；切回后重新跟随系统`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, '/index.html');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', scheme);
    await page.locator('#appbar [data-theme-toggle]').click();
    await expect(html).toHaveAttribute('data-theme', other);
    await page.locator('#appbar .nav a[data-screen="c2"]').click();
    await expect(page).toHaveURL(/ranking\.html$/);
    await expect(html).toHaveAttribute('data-theme', other);
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', other);
    // 切回与系统相同的主题：不再记住，之后跟随系统变化
    await page.locator('#appbar [data-theme-toggle]').click();
    await expect(html).toHaveAttribute('data-theme', scheme);
    expect(await page.evaluate((k) => localStorage.getItem(k), THEME_KEY)).toBeNull();
    await page.emulateMedia({ colorScheme: other });
    await expect(html).toHaveAttribute('data-theme', other);
  });
}

test('?theme=dark 下切到白天，顶栏链接带上新主题，换页后保持', async ({ page }) => {
  await open(page, '/index.html?theme=dark');
  await page.locator('#appbar [data-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page).toHaveURL(/index\.html\?theme=light/);
  await expect(page.locator('#appbar .nav a[data-screen="c2"]')).toHaveAttribute('href', 'ranking.html?theme=light');
  await page.locator('#appbar .nav a[data-screen="c2"]').click();
  await expect(page).toHaveURL(/ranking\.html\?theme=light/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('记住的主题在第一帧前生效，?theme 参数优先于记住的选择', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript((k) => localStorage.setItem(k, 'dark'), THEME_KEY);
  // 推迟 kit.js，确认 boot.js 自己就写对了主题（否则 kit.js 加载前会闪一下系统主题）
  await page.route('**/assets/kit.js', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.goto('/index.html', { waitUntil: 'commit' });
  await page.waitForFunction(() => document.documentElement.classList.contains('is-booting'));
  expect(await page.evaluate(() => [document.documentElement.dataset.theme, !!window.NWK])).toEqual(['dark', false]);
  await expect(page.locator('html')).not.toHaveClass(/is-booting/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await open(page, '/index.html?theme=light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('derive.js 与 kit.js 和 data/board.json 并行下载，且各只请求一次', async ({ page }) => {
  await open(page, '/index.html');
  const res = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((e) => ({ path: new URL(e.name).pathname, start: e.startTime, end: e.responseEnd })));
  const board = res.find((r) => r.path === '/data/board.json');
  for (const path of ['/assets/derive.js', '/assets/kit.js']) {
    const hits = res.filter((r) => r.path === path);
    expect(hits, `${path} 只应请求一次（preload 被 load() 复用）`).toHaveLength(1);
    expect(hits[0].start, `${path} 不应等 board.json 返回才开始下载`).toBeLessThan(board.end);
  }
});

test('数据读取失败时给出提示与重新加载按钮', async ({ page, errors }) => {
  await page.route('**/data/board.json', (r) => r.fulfill({ status: 500, body: 'oops' }));
  await page.goto('/index.html');
  const box = page.locator('.boot-error');
  await expect(box).toBeVisible();
  await expect(box).toContainText('HTTP 500');
  await expect(box.getByRole('button', { name: '重新加载' })).toBeVisible();
  errors.length = 0; // 这个用例故意制造失败，boot.js 会 console.error
});

test('⌘K 搜索贡献者并打开档案', async ({ page }) => {
  await open(page, '/index.html');
  await page.keyboard.press('ControlOrMeta+k');
  const box = page.locator('.cmdk.on input');
  await expect(box).toBeFocused();
  await box.fill('frog-07');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/profile\.html.*#u=frog-07/);
});

test('K.flip 只给视口里看得见的移动做动画，屏外删除的行不留残影', async ({ page }) => {
  await open(page, '/index.html');
  const res = await page.evaluate(() => {
    // 60 rows of 40px starting 800px above the viewport (900px tall): rows 20-42 are on screen
    const box = document.createElement('div');
    Object.assign(box.style, { position: 'absolute', top: '-800px', left: '0', width: '300px' });
    box.innerHTML = Array.from({ length: 60 }, (_, i) => `<div data-key="r${i}" style="height:40px">r${i}</div>`).join('');
    document.body.appendChild(box);
    const row = (k) => box.querySelector(`[data-key="${k}"]`);
    const moving = (k) => row(k).getAnimations().length > 0;
    // Reverse each block: 0-9 stay above, 10-49 straddle the viewport, 50-59 stay below
    NWK.flip(box, () => {
      const els = [...box.children];
      const order = [...els.slice(0, 10).reverse(), ...els.slice(10, 50).reverse(), ...els.slice(50).reverse()];
      box.append(...order);
    });
    const moved = { above: moving('r3'), below: moving('r52'), crossing: moving('r10'), visible: moving('r30') };
    document.getAnimations().forEach((a) => a.cancel());
    NWK.flip(box, () => {
      row('r1').remove(); // above the viewport
      row('r30').remove(); // on screen
      box.insertAdjacentHTML('beforeend', '<div data-key="r60" style="height:40px">r60</div>'); // enters below the viewport
    });
    const ghosts = box.querySelectorAll('[aria-hidden="true"]').length;
    const entered = moving('r60');
    box.remove();
    return { moved, ghosts, entered };
  });
  expect(res).toEqual({ moved: { above: false, below: false, crossing: true, visible: true }, ghosts: 1, entered: false });
});
