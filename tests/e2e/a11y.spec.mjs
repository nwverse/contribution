// 无障碍：键盘落点、焦点归还与读屏播报。与 pages.spec.mjs 分开，只检查辅助技术能感知的行为，页面外观不变。
import { test, expect, open, PAGES, BOARD, LAST, THIS_WEEK, weekValue, mag } from './fixtures.mjs';

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
    // 换人会整体替换抽屉内容，这里只确认读出区域没有累积；destroy() 的清理由「柱图 destroy」单独覆盖
    await page.locator('.drawer.on #pfBody').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/#u=frog-04/);
    await expect(live).toHaveCount(1);
    await expect(live).toHaveText('');
  });
});

test.describe('柱图 destroy', () => {
  test('destroy() 移除宿主旁的读出区域', async ({ page }) => {
    await open(page, '/index.html');
    // 单独建一张图，避免页面重绘（替换父节点）顺带删掉 live 区域而掩盖 destroy() 的清理
    const counts = await page.evaluate(() => {
      const wrap = document.createElement('div');
      const host = document.createElement('div');
      wrap.appendChild(host);
      document.body.appendChild(wrap);
      const c = NWK.columns(host, { data: [{ label: 'W1', v: 1 }, { label: 'W2', v: 2 }] });
      const live = () => wrap.querySelectorAll('[aria-live="polite"]').length;
      const before = live();
      c.destroy();
      const after = live();
      wrap.remove();
      return { before, after };
    });
    expect(counts).toEqual({ before: 1, after: 0 });
  });
});

test.describe('累计曲线与形态池', () => {
  // 两张图同样是 role=img，键盘移动高亮时由紧挨着的 aria-live 区域读出，鼠标悬停不播报
  test('档案抽屉的累计曲线用方向键移动时读出累计、当周与形态，destroy() 移除读出区域 @mobile', async ({ page }) => {
    const p = BOARD.people.find((x) => x.login === 'frog-03');
    await open(page, `/profile.html#u=${p.login}`);
    await page.locator('.drawer.on #wkSeg').getByText('累计').click();
    const chart = page.locator('.drawer.on #wkHost .chart.cum');
    await expect(chart).toHaveAttribute('role', 'img');
    const live = page.locator('.drawer.on #wkHost .chart.cum + [aria-live="polite"]');
    await expect(live).toHaveCount(1);
    await expect(live).toHaveText('');
    await chart.focus();
    await page.keyboard.press('End');
    await expect(live).toContainText(`进行中：截至此刻累计 ${mag(p.bonus)} 魔力，当周 +${mag(weekValue(p, THIS_WEEK))}，现在是`);
    await page.keyboard.press('ArrowLeft');
    await expect(live).toContainText(`：周末累计`);
    await expect(live).toContainText(`当周 +${mag(weekValue(p, BOARD.weeks[LAST - 1].start))}，当时是`);
    await expect(live).not.toContainText('进行中');
    await chart.blur();
    await expect(live).toHaveText('');

    // 把读出区域挪出宿主：切到「每周」时宿主会被整体替换，挪出去才能确认是 destroy() 自己删掉了它
    await page.evaluate(() => document.body.appendChild(document.querySelector('#wkHost .chart.cum + [aria-live="polite"]')));
    await expect(page.locator('body > [aria-live="polite"].sr-only')).toHaveCount(1);
    await page.locator('.drawer.on #wkSeg').getByText('每周').click();
    await expect(page.locator('.drawer.on #wkHost .chart.cum')).toHaveCount(0);
    await expect(page.locator('body > [aria-live="polite"].sr-only')).toHaveCount(0);
    await expect(page.locator('.drawer.on #wkHost [aria-live="polite"]')).toHaveCount(1); // 只剩每周柱图自己的
  });

  test('形态池的图用方向键换周时读出已孵化人数与各形态人数 @mobile', async ({ page }) => {
    await open(page, '/pond.html');
    const chart = page.locator('#chart');
    const live = page.locator('#chart + [aria-live="polite"]');
    await expect(live).toHaveCount(1);
    await expect(live).toHaveText('');
    // 焦点不在图上时换周不播报（周名由步进器自己的 live 区域读出）
    const short = (i) => page.evaluate((k) => NWK.week.short(k), i);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#stWk')).toContainText(await short(LAST - 1));
    await expect(live).toHaveText('');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#stWk')).toContainText(await short(LAST));

    await chart.focus();
    await page.keyboard.press('ArrowLeft');
    const sel = async () => (await page.locator('#chart .sel-tx').textContent()).trim();
    await expect(live).toContainText(`${await short(LAST - 1)}：${await sel()} 人，`);
    await expect(live).not.toContainText('截至此刻');
    await page.keyboard.press('ArrowRight');
    await expect(live).toContainText(`${await short(LAST)} 本周 · 截至此刻：${await sel()} 人`);
    await chart.blur();
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

  test('背景排行榜方向键选中时用 aria-activedescendant 告知读屏，支持 Home / End', async ({ page }) => {
    await open(page, '/profile.html');
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer.on')).toHaveCount(0);
    const rows = page.locator('#rows');
    const vis = rows.locator('.lrow:not([hidden])');
    const selected = rows.locator('.lrow[aria-selected="true"]');
    // The active descendant must name the expected visible row, and it must be the only selected one
    const expectActive = async (row) => {
      const id = await row.getAttribute('id');
      expect(id).toMatch(/^pf-opt-/);
      await expect(rows).toHaveAttribute('aria-activedescendant', id);
      await expect(row).toHaveAttribute('aria-selected', 'true');
      await expect(selected).toHaveCount(1);
    };

    const n = await vis.count();
    expect(n).toBeGreaterThan(2);
    const ids = await vis.evaluateAll((rs) => rs.map((r) => r.id));
    expect(new Set(ids).size, 'option id 唯一').toBe(n);

    await rows.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expectActive(vis.nth(1));
    await page.keyboard.press('End');
    await expectActive(vis.last());
    await page.keyboard.press('Home');
    await expectActive(vis.first());
    await expect(rows).toBeFocused();

    // Filtering clears the stale selection; ArrowDown from the search box picks the first filtered row
    const q = await vis.nth(1).getAttribute('data-login');
    await page.locator('#lbSearch').fill(q);
    await expect(selected).toHaveCount(0);
    expect(await rows.getAttribute('aria-activedescendant')).toBeFalsy();
    await page.keyboard.press('ArrowDown');
    await expect(rows).toBeFocused();
    await expectActive(vis.first());
    expect(await vis.first().getAttribute('data-login')).toContain(q);
  });
});

test.describe('我的菜单', () => {
  const login = BOARD.people[0].login;
  const remember = (page) => page.addInitScript((l) => localStorage.setItem('nwverse:contribution:me', JSON.stringify({ v: 1, login: l })), login);
  const active = (page) => page.evaluate(() => {
    const a = document.activeElement;
    return { inMenu: !!a.closest('.me-menu'), btn: a.matches('#appbar .me-btn'), action: a.dataset.action || null };
  });
  const ACTIONS = ['me-go', 'me-rank', 'me-pick', 'me-forget'];

  test('收起时菜单项不在 Tab 序里', async ({ page }) => {
    await remember(page);
    await open(page, '/index.html');
    const btn = page.locator('#appbar .me-btn');
    await expect(btn).toContainText(`@${login}`);
    await btn.focus();
    for (let k = 0; k < ACTIONS.length + 2; k++) {
      await page.keyboard.press('Tab');
      expect((await active(page)).inMenu, `第 ${k + 1} 下 Tab`).toBe(false);
    }
    // 反向同样跳过
    await btn.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    expect(await active(page)).toMatchObject({ inMenu: false, btn: true });
  });

  test('方向键在菜单项间移动；Esc 关闭后焦点回到按钮', async ({ page }) => {
    await remember(page);
    await open(page, '/index.html');
    const btn = page.locator('#appbar .me-btn');
    await btn.click();
    await expect(page.locator('#appbar .me-menu.on')).toHaveCount(1);
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect((await active(page)).action).toBe('me-go');
    const steps = [['ArrowDown', 'me-rank'], ['End', 'me-forget'], ['ArrowDown', 'me-go'], ['ArrowUp', 'me-forget'], ['Home', 'me-go'], ['ArrowUp', 'me-forget']];
    for (const [key, want] of steps) {
      await page.keyboard.press(key);
      expect((await active(page)).action, key).toBe(want);
    }
    await expect(page.locator('#appbar .me-menu.on')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#appbar .me-menu.on')).toHaveCount(0);
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(btn).toBeFocused();
  });

  test('Tab 离开展开的菜单时收起；Shift+Tab 回到按钮', async ({ page }) => {
    await remember(page);
    await open(page, '/index.html');
    const btn = page.locator('#appbar .me-btn');
    await btn.click();
    await expect(page.locator('#appbar .me-menu.on')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(page.locator('#appbar .me-menu.on')).toHaveCount(0);
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(await active(page)).toMatchObject({ inMenu: false, btn: false });
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);

    await btn.click();
    await expect(page.locator('#appbar .me-menu.on')).toHaveCount(1);
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#appbar .me-menu.on')).toHaveCount(0);
    await expect(btn).toBeFocused();
  });

  test('从菜单打开「更换账号」，关闭后焦点回到按钮', async ({ page }) => {
    await remember(page);
    await open(page, '/index.html');
    const btn = page.locator('#appbar .me-btn');
    await btn.click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');
    expect((await active(page)).action).toBe('me-pick');
    await page.keyboard.press('Enter');
    await expect(page.locator('.me-picker.on input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.me-picker.on')).toHaveCount(0);
    await expect(btn).toBeFocused();
  });
});
