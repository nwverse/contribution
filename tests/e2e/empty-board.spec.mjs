import { test, expect, open, PAGES, emptyBoard } from './fixtures.mjs';

test.beforeEach(async ({ page }) => {
  await page.route('**/data/board.json', (route) => route.fulfill({ json: emptyBoard() }));
});

for (const pg of PAGES) {
  test(`零贡献快照：${pg.label}页可浏览并保留站点导航 @mobile`, async ({ page, isMobile }) => {
    await open(page, `/${pg.file}`);
    const main = page.locator('main');
    await expect(page.locator('.boot-error')).toHaveCount(0);
    await expect(main.getByRole('heading').first()).toBeVisible();
    if (['c1', 'c2', 'c5'].includes(pg.id)) {
      await expect(main.getByRole('heading', { name: '暂无贡献记录', exact: true })).toBeVisible();
      await expect(main).toContainText('有贡献记录后');
    } else if (pg.id === 'c4') {
      await expect(page.locator('#headline')).toContainText('0 人在孵化');
      await expect(page.locator('#cohort')).toContainText('暂无贡献记录');
    } else if (pg.id === 'c3') {
      await expect(page.locator('#rows [data-login]')).toHaveCount(0);
    }
    await expect(main).not.toContainText(/NaN|Infinity|Invalid Date/);
    const nav = isMobile ? page.locator('.tabbar') : page.locator('#appbar .nav');
    const to = pg.id === 'rules' ? 'c1' : 'rules';
    await nav.locator(`a[data-screen="${to}"]`).click();
    await expect(page).toHaveURL(to === 'c1' ? /\/index\.html$/ : /\/rules\.html$/);
    await expect(page.locator('html')).not.toHaveClass(/is-booting/);
    await expect(page.locator('main').getByRole('heading').first()).toBeVisible();
  });
}

for (const [file, labels] of [
  ['index.html', ['前一周', '后一周']],
  ['ranking.html', ['播放']],
  ['pond.html', ['前一周', '后一周', '回放形态变化']],
]) {
  test(`零贡献快照：${file} 无可切换或回放的周 @mobile`, async ({ page }) => {
    await open(page, `/${file}`);
    const main = page.locator('main');
    for (const name of labels) await expect(main.getByRole('button', { name, exact: true })).toBeDisabled();
    await expect(main.getByRole('slider')).toHaveCount(0);
    const content = await main.innerText();
    await main.focus();
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'p', 't']) await page.keyboard.press(key);
    await expect(main).toHaveText(content, { useInnerText: true });
    await expect(main).not.toContainText(/NaN|Infinity|Invalid Date/);
  });
}
