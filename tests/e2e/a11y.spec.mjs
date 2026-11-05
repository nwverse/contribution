// 无障碍：键盘落点、焦点归还与读屏播报。与 pages.spec.mjs 分开，只检查辅助技术能感知的行为，页面外观不变。
import { test, expect, open, PAGES, BOARD, LAST, weekValue, mag } from './fixtures.mjs';

for (const { file, label } of PAGES) {
  test(`${label}：第一下 Tab 落在「跳到正文」，回车后焦点进入正文`, async ({ page }) => {
    await open(page, `/${file}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    const skip = page.locator('a.skip-link');
    await expect(skip).toHaveCount(1);
    await expect(skip).not.toBeInViewport(); // 未聚焦时不占画面

    const hash = await page.evaluate(() => location.hash);
    await page.keyboard.press('Tab');
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute('href', '#main');
    await expect(skip).toBeInViewport();

    await page.keyboard.press('Enter');
    await expect(page.locator('main#main')).toBeFocused();
    expect(await page.evaluate(() => location.hash), '不改动页面自己的 hash').toBe(hash);

    // 正文之后的下一下 Tab 不再回到顶栏
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('#appbar'))).toBe(false);
  });
}

test.describe('柱图', () => {
  // 柱图宿主是 role=img，子元素对读屏不可见；键盘选中的那一周由紧挨着的 aria-live 区域读出
  const liveOf = (page, sel) => page.locator(`${sel} + [aria-live="polite"]`);

  for (const [id, key] of [['#chartActive', 'active'], ['#chartMerged', 'merged']]) {
    test(`本周页 ${id} 用方向键移动时读出当周数值`, async ({ page }) => {
      await open(page, '/index.html');
      const live = liveOf(page, id);
      await expect(live).toHaveCount(1);
      await expect(live).toHaveText('');
      await page.locator(id).focus();
      await page.keyboard.press('End');
      await expect(live).toContainText(String(BOARD.weeks[LAST][key]));
      await page.keyboard.press('ArrowLeft');
      await expect(live).toContainText(`：${BOARD.weeks[LAST - 1][key]}`);
      await expect(live).not.toContainText('进行中');
      await page.locator(id).blur();
      await expect(live).toHaveText('');
    });
  }

  test('档案抽屉的每周柱图读出本周魔力与近 4 周均值，换人后不留旧区域', async ({ page }) => {
    const p = BOARD.people.find((x) => x.login === 'frog-03');
    await open(page, `/profile.html#u=${p.login}`);
    const chart = page.locator('.drawer.on #wkHost .chart');
    await expect(chart).toHaveAttribute('role', 'img');
    const live = page.locator('.drawer.on #wkHost [aria-live="polite"]');
    await expect(live).toHaveCount(1);
    await chart.focus();
    await page.keyboard.press('End');
    await expect(live).toContainText(`${mag(weekValue(p, BOARD.weeks[LAST].start))}魔力`);
    await expect(live).toContainText('近 4 周均值');
    // 每次重绘都会 destroy 旧图：换人后抽屉里仍只有一个读出区域
    await page.locator('.drawer.on #pfBody').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/#u=frog-04/);
    await expect(live).toHaveCount(1);
    await expect(live).toHaveText('');
  });
});

test.describe('孵化台', () => {
  test('清空筛选后焦点回到筛选框，取消单项后焦点回到对应 chip', async ({ page }) => {
    // 让考核中的蛙卵全是组织成员，勾「组织外」必然落到空状态，且只取消「组织外」就有结果
    const board = structuredClone(BOARD);
    for (const p of board.people) if (p.newbie.status === 'pending' && p.level === null) p.member = true;
    await page.route('**/data/board.json', (route) => route.fulfill({ json: board }));
    await open(page, '/hatchery.html');
    const chips = page.locator('#chips .chip');
    const focusedId = () => page.evaluate(() => document.activeElement.id || document.activeElement.tagName);

    // 结果栏里的「清空筛选」
    await chips.first().click();
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#res [data-clear]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#res')).toBeHidden();
    for (const c of await chips.all()) await expect(c).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#q')).toBeFocused();
    expect(await focusedId()).toBe('q');

    // 空状态里的「取消「组织外」」
    const out = page.locator('#chips .chip[data-k="out"]');
    await out.click();
    const drop = page.locator('#board [data-drop="out"]');
    await expect(drop).toBeVisible();
    await drop.focus();
    await page.keyboard.press('Enter');
    await expect(drop).toHaveCount(0);
    await expect(out).toHaveAttribute('aria-pressed', 'false');
    await expect(out).toBeFocused();
    await expect(page.locator('#board article.egg').first()).toBeVisible();

    // 空状态里的「清空筛选」
    await out.click();
    await page.locator('#board [data-clear]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#board [data-clear]')).toHaveCount(0);
    for (const c of await chips.all()) await expect(c).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#q')).toBeFocused();
    // 鼠标点「清空筛选」不把焦点放进筛选框（手机上会弹出键盘）
    await chips.first().click();
    await page.locator('#res [data-clear]').click();
    await expect(page.locator('#res')).toBeHidden();
    await expect(page.locator('#q')).not.toBeFocused();
  });
});

test.describe('档案', () => {
  test('底栏换人后焦点留在抽屉里，落在同侧按钮上', async ({ page }) => {
    await open(page, '/profile.html#u=frog-03');
    await expect(page.locator('.drawer.on #pfBody')).toContainText('frog-03');
    const nx = page.locator('.drawer .pf-step.nx');
    await expect(nx).toHaveAttribute('data-step', '1');
    const next = (await nx.getAttribute('aria-label')).split('：')[1];
    await nx.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#u=${next}$`));
    await expect(page.locator('.drawer.on #pfBody')).toContainText(next);
    const focus = () => page.evaluate(() => {
      const a = document.activeElement;
      return { inDrawer: !!a.closest('.drawer'), nx: a.matches('.pf-step.nx'), prev: a.matches('.pf-step[data-step="-1"]'), drawer: a.matches('.drawer') };
    });
    expect(await focus()).toMatchObject({ inDrawer: true, nx: true });
    // 焦点在底栏按钮上时用 ← 换人，同样不丢焦点
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/#u=frog-03$/);
    expect(await focus()).toMatchObject({ inDrawer: true, nx: true });
  });

  test('换到最后一位时焦点退到上一位按钮或抽屉', async ({ page }) => {
    await open(page, '/profile.html');
    const [penult, last] = await page.evaluate(() => NW.people.slice(-2).map((p) => p.login));
    await page.goto(`/profile.html#u=${penult}`);
    await page.reload();
    await expect(page.locator('.drawer.on #pfBody')).toContainText(penult);
    await page.locator('.drawer .pf-step.nx').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#u=${last}$`));
    await expect(page.locator('.drawer .pf-step.nx')).toBeDisabled();
    const f = await page.evaluate(() => {
      const a = document.activeElement;
      return { inDrawer: !!a.closest('.drawer'), ok: a.matches('.pf-step[data-step="-1"]:not([disabled]), .drawer') };
    });
    expect(f).toEqual({ inDrawer: true, ok: true });
  });

  test('找不到的人点「看看默认档案」后焦点留在抽屉里', async ({ page }) => {
    await open(page, '/profile.html#u=no-such-frog-zz');
    const go = page.locator('.drawer.on [data-go]');
    await go.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.drawer.on .pf-missing')).toHaveCount(0);
    expect(await page.evaluate(() => !!document.activeElement.closest('.drawer'))).toBe(true);
  });
});
