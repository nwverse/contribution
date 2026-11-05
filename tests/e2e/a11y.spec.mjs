// 无障碍：跳到正文链接、页面语言。与 pages.spec.mjs 分开，逐页检查键盘用户的第一个落点。
import { test, expect, open, PAGES } from './fixtures.mjs';

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
