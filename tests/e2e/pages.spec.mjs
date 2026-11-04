// 各页主要交互，数字与测试数据逐一核对。
import { test, expect, open, BOARD, LAST, THIS_WEEK, weekValue, mag } from './fixtures.mjs';

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

test.describe('孵化台', () => {
  test('蛙卵逐个列出，三组人数之和等于考核中人数', async ({ page }) => {
    const pending = P.filter((p) => p.newbie.status === 'pending' && p.level === null).length;
    await open(page, '/hatchery.html');
    await expect(page.locator('#headline')).toContainText(String(pending));
    await expect(page.locator('#board article.egg')).toHaveCount(pending);
  });
});

test.describe('形态池', () => {
  test('每级人数与数据一致，空等级显示虚位以待', async ({ page }) => {
    await open(page, '/pond.html');
    await expect(page.locator('#headline')).toContainText(String(BOARD.summary.hatched));
    const vacant = BOARD.summary.levelCounts.filter((n) => n === 0).length;
    if (vacant) await expect(page.locator('#ladder')).toContainText('虚位以待');
  });
});

test('档案页不带 #u= 时打开总榜第一名', async ({ page }) => {
  await open(page, '/profile.html');
  await expect(page.locator('.drawer.on #pfBody')).toContainText(BOARD.people[0].login);
});
