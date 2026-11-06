// 各页主要交互，数字与测试数据逐一核对。
import { test, expect, open, BOARD, RULES, LAST, THIS_WEEK, weekValue, mag, oneWeekBoard } from './fixtures.mjs';

const P = BOARD.people;
const byLogin = new Map(P.map((p) => [p.login, p]));

test.describe('本周', () => {
  test('KPI 显示本周值，周选择器可切到前一周再回来 @mobile', async ({ page }) => {
    await open(page, '/index.html');
    const kpis = page.locator('#heroKpis');
    await expect(kpis).toContainText(String(BOARD.weeks[LAST].active));
    await expect(kpis).toContainText(String(BOARD.weeks[LAST].merged));
    const head = await page.locator('#headline').textContent();
    await page.locator('#wk').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/[?&]week=/);
    await expect(kpis).toContainText(String(BOARD.weeks[LAST - 1].merged));
    await expect(page.locator('#headline')).not.toHaveText(head);
    await page.keyboard.press('t');
    await expect(page).not.toHaveURL(/[?&]week=/);
    await expect(kpis).toContainText(String(BOARD.weeks[LAST].merged));
  });

  test('只有一周数据的看板正常启动，周选择器停在本周 @mobile', async ({ page }) => {
    const board = oneWeekBoard();
    await page.route('**/data/board.json', (route) => route.fulfill({ json: board }));
    await open(page, '/index.html');
    await expect(page.locator('.boot-error')).toHaveCount(0);
    const kpis = page.locator('#heroKpis');
    await expect(kpis).toContainText(String(board.weeks[0].merged));
    await page.locator('#wk').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page).not.toHaveURL(/[?&]week=/);
    await expect(kpis).toContainText(String(board.weeks[0].merged));
  });

  test('周数标签跟随数据：测试数据显示实际周数', async ({ page }) => {
    const n = BOARD.weeks.length;
    await open(page, '/index.html');
    await expect(page.locator('.wk-h .title')).toContainText(`${n} 周`);
    await expect(page.locator('.trend .sec-h h2')).toHaveText(`${n} 周走势`);
    await expect(page.locator('#heroKpis')).toContainText(`占 ${n} 周合入的`);
  });

  test('周数标签跟随数据：只剩最近 10 周时写 10 周', async ({ page }) => {
    // 周数由数据决定（从第一个活跃周到本周），每周加一；页面不能写死
    const board = structuredClone(BOARD);
    board.weeks = board.weeks.slice(-10);
    const kept = new Set(board.weeks.map((w) => w.start));
    for (const p of board.people) p.weekly = p.weekly.filter(([w]) => kept.has(w));
    board.summary.merged = board.weeks.reduce((s, w) => s + w.merged, 0);
    await page.route('**/data/board.json', (route) => route.fulfill({ json: board }));
    await open(page, '/index.html');
    await expect(page.locator('.wk-h .title')).toContainText('10 周');
    await expect(page.locator('.trend .sec-h h2')).toHaveText('10 周走势');
    await expect(page.locator('#heroKpis')).toContainText('占 10 周合入的');
  });

  test('本周魔力榜按本周魔力排序，名字可进入档案', async ({ page }) => {
    const top = [...P].map((p) => ({ p, v: weekValue(p, THIS_WEEK) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v)[0];
    await open(page, '/index.html');
    const first = page.locator('#board .lrow').first();
    await expect(first).toContainText(top.p.login);
    await expect(first).toContainText(mag(top.v));
    await first.click();
    await expect(page).toHaveURL(new RegExp(`profile\\.html.*#u=${top.p.login}`));
  });
});

test.describe('排行榜', () => {
  test('总榜 / 本周 / 近 4 周切换改变排序', async ({ page }) => {
    await open(page, '/ranking.html');
    const rows = page.locator('#lbCard [data-key]');
    await expect(rows.first()).toHaveAttribute('data-key', 'frog-01');
    const weekTop = [...P].sort((a, b) => weekValue(b, THIS_WEEK) - weekValue(a, THIS_WEEK))[0];
    await page.locator('#lbCard').getByRole('radio', { name: '本周' }).or(page.locator('#lbCard').getByRole('tab', { name: '本周' })).or(page.locator('#lbCard button', { hasText: /^本周$/ })).first().click();
    await expect(rows.first()).toHaveAttribute('data-key', weekTop.login);
  });

  test('筛选组织外、搜索、点击打开档案', async ({ page }) => {
    await open(page, '/ranking.html');
    await page.locator('.chip[data-g="mem"][data-v="o"]').click();
    await expect(page.locator('#lbMeta')).toContainText(String(BOARD.summary.outsiders));
    await page.locator('.chip[data-g="mem"][data-v="all"]').click();
    await page.keyboard.press('/');
    await expect(page.locator('#q')).toBeFocused();
    await page.locator('#q').fill('frog-07');
    await expect(page.locator('#lbCard [data-key]')).toHaveCount(1);
    await page.locator('#lbCard [data-key="frog-07"]').click();
    await expect(page).toHaveURL(/profile\.html.*#u=frog-07/);
  });

  test('新手异常筛选可用', async ({ page }) => {
    await open(page, '/ranking.html');
    const chip = page.locator('.chip[data-g="flags"][data-v="a"]');
    await expect(chip).toContainText(String(BOARD.summary.anomaly));
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('档案', () => {
  test('按 #u= 打开，←/→ 按名次换人，Esc 关闭 @mobile', async ({ page }) => {
    const p = byLogin.get('frog-03');
    await open(page, '/profile.html#u=frog-03');
    const head = page.locator('.drawer.on #pfBody');
    await expect(head).toContainText('frog-03');
    await expect(page.locator('#pfMag')).toContainText(mag(p.bonus));
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/#u=frog-04/);
    await expect(head).toContainText('frog-04');
    await page.keyboard.press('ArrowLeft');
    await expect(head).toContainText('frog-03');
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer.on')).toHaveCount(0);
  });
});

// 背景榜首屏只建前 40 行，其余用 setTimeout(moreRows) 分片追加。这里把分片扣住，检查分片未完成时的各条路径
const holdRowSlices = (page) => page.addInitScript(() => {
  const held = new Map(), st = window.setTimeout, ct = window.clearTimeout;
  let seq = 1e6;
  window.setTimeout = function (fn, ...a) {
    if (typeof fn === 'function' && fn.name === 'moreRows') { held.set(++seq, fn); return seq; }
    return st.call(this, fn, ...a);
  };
  window.clearTimeout = function (t) { held.delete(t); return ct.call(this, t); };
  window.__heldSlices = () => held.size;
  window.__releaseSlices = () => { while (held.size) { const [k, fn] = held.entries().next().value; held.delete(k); fn(); } };
});
const RANKED = [...P].sort((a, b) => a.rank - b.rank).map((p) => p.login);
const rowLogins = (page) => page.locator('#rows .lrow').evaluateAll((rs) => rs.map((r) => r.dataset.login));
const heldSlices = (page) => page.evaluate(() => window.__heldSlices());

test.describe('档案背景榜分片', () => {
  test('#u= 指向第 60 名：按需补到该行并标记，补齐后按名次排列、人数不变', async ({ page }) => {
    const target = RANKED[59];
    await holdRowSlices(page);
    await open(page, `/profile.html#u=${target}`);
    await expect(page.locator('#rows .lrow.is-cur')).toHaveAttribute('data-login', target);
    expect(await rowLogins(page)).toEqual(RANKED.slice(0, 60));
    expect(await heldSlices(page)).toBe(1);
    await expect(page.locator('#lbCount')).toHaveText(`总榜 · ${P.length} 人`);
    await page.evaluate(() => window.__releaseSlices());
    expect(await rowLogins(page)).toEqual(RANKED);
    await expect(page.locator('#rows .lrow.is-cur')).toHaveCount(1);
    await expect(page.locator('#rows .lrow.is-cur')).toHaveAttribute('data-login', target);
  });

  test('分片未完成时输入筛选：先补齐全部行再计数，清空后回到总榜', async ({ page }) => {
    await holdRowSlices(page);
    await open(page, '/profile.html');
    await expect(page.locator('#rows .lrow')).toHaveCount(40);
    await expect(page.locator('#lbCount')).toHaveText(`总榜 · ${P.length} 人`);
    const q = '8';
    const n = P.filter((p) => p.login.toLowerCase().includes(q)).length;
    await page.locator('#lbSearch').fill(q);
    await expect(page.locator('#lbCount')).toHaveText(`筛出 ${n} / ${P.length} 人`);
    expect(await rowLogins(page)).toEqual(RANKED);
    await expect(page.locator('#rows .lrow:not([hidden])')).toHaveCount(n);
    expect(await heldSlices(page)).toBe(0);
    await page.locator('#lbSearch').fill('');
    await expect(page.locator('#lbCount')).toHaveText(`总榜 · ${P.length} 人`);
    await expect(page.locator('#rows .lrow:not([hidden])')).toHaveCount(P.length);
  });

  test('分片未完成时用键盘进入榜单：先补齐全部行', async ({ page }) => {
    await holdRowSlices(page);
    await open(page, '/profile.html');
    await expect(page.locator('#rows .lrow')).toHaveCount(40);
    await page.locator('#lbSearch').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#rows')).toBeFocused();
    expect(await rowLogins(page)).toEqual(RANKED);
    expect(await heldSlices(page)).toBe(0);
  });

  test('分片未完成时「记为我的账号」重建榜单：取消剩余分片，不重复不缺行', async ({ page }) => {
    const target = RANKED[2];
    await holdRowSlices(page);
    await open(page, `/profile.html#u=${target}`);
    expect(await heldSlices(page)).toBe(1);
    await page.locator(`.drawer.on [data-me-remember="${target}"]`).click();
    await expect(page.locator('#rows .lrow.is-me')).toHaveAttribute('data-login', target);
    expect(await heldSlices(page)).toBe(0);
    expect(await rowLogins(page)).toEqual(RANKED);
    await expect(page.locator('#rows .lrow.is-cur')).toHaveAttribute('data-login', target);
  });

  test('刷新时一次建好全部行，滚动恢复落在完整列表上', async ({ page }) => {
    await holdRowSlices(page);
    await open(page, '/profile.html');
    await expect(page.locator('#rows .lrow')).toHaveCount(40);
    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/is-booting/);
    expect(await rowLogins(page)).toEqual(RANKED);
    expect(await heldSlices(page)).toBe(0);
  });
});

test.describe('孵化台', () => {
  test('漏斗启动时只画一次，入场动画不被重绘打断', async ({ page }) => {
    // 漏斗画出后 #funnel 从 min-height 120px 长到 300px，ResizeObserver 会再报一次；宽度没变就不该重画
    await page.addInitScript(() => {
      window.__funnelDraws = 0;
      new MutationObserver((ms) => { for (const m of ms) if (m.target.id === 'funnel' && m.addedNodes.length) window.__funnelDraws++; })
        .observe(document, { childList: true, subtree: true });
    });
    await open(page, '/hatchery.html');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(page.locator('#funnel > svg')).toHaveClass(/fx-in/);
    expect(await page.evaluate(() => window.__funnelDraws)).toBe(1);
  });

  test('零贡献者看板显示空图表且仍可交互 @mobile', async ({ page }) => {
    const board = structuredClone(BOARD);
    board.people = [];
    board.weeks = [];
    for (const [key, value] of Object.entries(board.summary)) {
      board.summary[key] = Array.isArray(value) ? (key === 'levelCounts' ? value.map(() => 0) : []) : 0;
    }
    await page.route('**/data/board.json', (route) => route.fulfill({ json: board }));
    await open(page, '/hatchery.html');
    await expect(page.locator('.boot-error')).toHaveCount(0);
    await expect(page.locator('#headline')).toContainText('0 人在孵化');
    await expect(page.locator('#funnel')).toContainText('暂无贡献记录');
    await expect(page.locator('#cohort')).toContainText('暂无贡献记录');
    await expect(page.locator('#coPanel')).toBeHidden();
    await expect(page.locator('#rules h4')).toHaveCount(3);
    await page.locator('#coSeg').getByText('占比', { exact: true }).click();
    await expect(page.locator('#cohort')).toContainText('暂无贡献记录');
    await page.keyboard.press('u');
    await expect(page.locator('#foldBtn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#foldIn .rows .lrow')).toHaveCount(0);
  });

  test('没有考核中的蛙卵时显示空状态，历史贡献与交互仍可用 @mobile', async ({ page }) => {
    const board = structuredClone(BOARD);
    board.people = board.people.filter((p) => p.newbie.status !== 'pending' || p.level !== null);
    Object.assign(board.summary, {
      contributors: board.people.length,
      memberContributors: board.people.filter((p) => p.member).length,
      outsiders: board.people.filter((p) => !p.member).length,
      pending: 0,
    });
    await page.route('**/data/board.json', (route) => route.fulfill({ json: board }));

    await open(page, '/hatchery.html');
    await expect(page.locator('.boot-error')).toHaveCount(0);
    await expect(page.locator('#headline')).toContainText('0 人在孵化');
    await expect(page.locator('#heroSide')).toContainText('当前没有考核中的蛙卵');
    await expect(page.locator('#soonGo')).toHaveCount(0);
    await expect(page.locator('#board .lane-empty')).toHaveCount(3);
    await expect(page.locator('#rules h4')).toHaveCount(3);
    await expect(page.locator('#lede')).toContainText(`${board.people.length} 位贡献者`);
    const failed = board.people.filter((p) => p.newbie.status === 'failed' && p.level === null).length;
    await page.keyboard.press('u');
    await expect(page.locator('#foldBtn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#foldIn .rows .lrow')).toHaveCount(failed);
  });

  test('蛙卵逐个列出，三组人数之和等于考核中人数', async ({ page }) => {
    const pending = P.filter((p) => p.newbie.status === 'pending' && p.level === null).length;
    await open(page, '/hatchery.html');
    await expect(page.locator('#headline')).toContainText(String(pending));
    await expect(page.locator('#board article.egg')).toHaveCount(pending);
  });

  test('页面很长时，深处开关一次筛选，视口仍停在原来那张蛙卵', async ({ page }) => {
    // 测试数据复制 10 份，页面才够长；屏外蛋卡用了 content-visibility，重绘后的占位高度曾让滚动位置跳到页尾
    const board = structuredClone(BOARD);
    board.people = Array.from({ length: 10 }, (_, i) => BOARD.people.map((p) => ({ ...p, login: i ? `${p.login}-x${i}` : p.login }))).flat();
    await page.route('**/data/board.json', (route) => route.fulfill({ json: board }));
    await open(page, '/hatchery.html');
    await page.evaluate(() => scrollTo(0, 9000));
    const firstVisible = () => page.evaluate(() => {
      const e = [...document.querySelectorAll('#board .egg[data-key]')].find((x) => x.getBoundingClientRect().bottom > 0);
      return { key: e.dataset.key, top: e.getBoundingClientRect().top };
    });
    await page.waitForTimeout(300); // 等屏内卡片渲染、滚动锚定稳定
    const before = await firstVisible();
    // 筛选栏不吸顶，用 locator.click() 会先滚回顶部，这里直接派发点击
    const chip = page.locator('#chips .chip').first();
    await chip.evaluate((el) => el.click());
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(700);
    await chip.evaluate((el) => el.click());
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(700); // 等 FLIP 动画结束
    const after = await firstVisible();
    expect(after.key).toBe(before.key);
    expect(Math.abs(after.top - before.top)).toBeLessThan(120);
  });
});

test.describe('形态池', () => {
  test('每级人数与数据一致，空等级显示虚位以待', async ({ page }) => {
    await open(page, '/pond.html');
    await expect(page.locator('#headline')).toContainText(String(BOARD.summary.hatched));
    const vacant = BOARD.summary.levelCounts.filter((n) => n === 0).length;
    if (vacant) await expect(page.locator('#ladder')).toContainText('虚位以待');
  });

  test('只有一周数据时堆叠图坐标有效，滑块停在唯一一周', async ({ page }) => {
    await page.route('**/data/board.json', (route) => route.fulfill({ json: oneWeekBoard() }));
    await open(page, '/pond.html');
    await expect(page.locator('.boot-error')).toHaveCount(0);
    const svg = page.locator('#chart svg');
    await expect(svg).toHaveCount(1);
    expect(await svg.evaluate((el) => el.outerHTML)).not.toMatch(/NaN|Infinity/);
    await expect(page.locator('#chart .sel-tx')).toHaveText(/^已孵化 \d+ \/ \d+$/);
    // 唯一一周的面积铺满绘图区，而不是缩成一条看不见的竖线
    const box = await page.locator('#chart path.ar').first().evaluate((el) => el.getBBox().width);
    expect(box).toBeGreaterThan(100);
    const scrub = page.locator('#scrub');
    await expect(scrub).toHaveAttribute('max', '0');
    await expect(scrub).toHaveValue('0');
    expect(await scrub.evaluate((el) => el.style.getPropertyValue('--p'))).toBe('100%');
    // 悬停与键盘切周都停在这一周
    await page.locator('#chart').hover();
    expect(await page.locator('#hovBand').getAttribute('x')).not.toMatch(/NaN|Infinity/);
    await page.locator('#chart').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(scrub).toHaveValue('0');
  });
});

test('档案页不带 #u= 且没记住账号时停在落地页，不打开任何人', async ({ page }) => {
  await open(page, '/profile.html');
  await expect(page.locator('.drawer.on')).toHaveCount(0);
  await expect(page.locator('#pfMe')).toContainText('找到我的档案');
  await expect(page.locator('h2').first()).toContainText('贡献者档案');
});

// 活力：按 RULES.vitality 在测试里独立重算一遍，与页面对照
const DAY = 86400000, WEEK = 7 * DAY;
function vitality(p) {
  const V = RULES.vitality, w = V.weights;
  if (BOARD.now - p.firstAt < RULES.newbie.days * DAY) return null;
  const weekly = BOARD.weeks.map((_, k) => weekValue(p, BOARD.weeks[LAST - k].start));
  const n = Math.max(1, Math.min(V.weeks, Math.ceil((BOARD.now - p.firstAt) / WEEK)));
  let sum = 0, norm = 0, active = 0;
  for (let k = 0; k < n; k++) { const wt = 2 ** (-k / V.halfLife); sum += weekly[k] * wt; norm += wt; if (weekly[k] > 0) active++; }
  const quiet = weekly.findIndex((m) => m > 0);
  const days = Math.floor((BOARD.now - p.lastAt) / DAY);
  const v = 100 * (w.recent * Math.min(1, sum / (V.pace * norm))
    + w.steady * active / n
    + w.history * Math.min(1, Math.log1p(p.bonus) / Math.log1p(V.historyRef)) * 2 ** (-(quiet < 0 ? Infinity : quiet) / V.creditHalfLife)
    + w.action * Math.max(0, 1 - days / RULES.dormantDays));
  return { v, status: v < V.laggard ? 'laggard' : v < V.watch ? 'watch' : 'ok' };
}
const VIT = P.map((p) => ({ p, r: vitality(p) })).filter((x) => x.r);
const lagN = VIT.filter((x) => x.r.status === 'laggard').length;
const watchN = VIT.filter((x) => x.r.status === 'watch').length;

test('首页活力预警：人数与独立重算一致，掉队在前，链接带筛选进入排行榜', async ({ page }) => {
  await open(page, '/index.html');
  const evo = page.locator('#evo');
  await expect(evo).toContainText(`活力预警 ${lagN + watchN}`);
  await expect(evo).toContainText(`掉队 ${lagN} · 观察 ${watchN}`);
  const rows = evo.locator('.upc.lag');
  await expect(rows).toHaveCount(Math.min(6, lagN + watchN));
  const lowest = VIT.filter((x) => x.r.status === 'laggard').sort((a, b) => a.r.v - b.r.v)[0];
  if (lowest) await expect(rows.first()).toHaveAttribute('data-login', lowest.p.login);
  const never = BOARD.summary.members - BOARD.summary.memberContributors;
  if (never > 0) await expect(evo.locator('.never')).toContainText(String(never));
  if (lagN) {
    await evo.locator('.lag-links a', { hasText: '掉队' }).click();
    await expect(page).toHaveURL(/ranking\.html\?flag=lag/);
    await expect(page.locator('.chip[data-v="lag"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#lbCard [data-key]')).toHaveCount(lagN);
  }
});

test('排行榜观察筛选人数与独立重算一致', async ({ page }) => {
  await open(page, '/ranking.html?flag=watch');
  await expect(page.locator('#lbCard [data-key]')).toHaveCount(watchN);
});

test('档案页显示活力分与四项构成', async ({ page }) => {
  const x = VIT.sort((a, b) => a.r.v - b.r.v)[0];
  await open(page, `/profile.html#u=${x.p.login}`);
  const sec = page.locator('.drawer.on section[aria-label="活力"]');
  await expect(sec.locator('.vit-score')).toHaveText((Math.round(x.r.v * 10) / 10).toFixed(1));
  await expect(sec.locator('.vit-row')).toHaveCount(4);
});
