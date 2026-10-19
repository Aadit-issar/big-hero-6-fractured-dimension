import { expect, test } from '@playwright/test';

test('the ATLAS advisor is discoverable, honest when unlinked, hideable with the HUD and never blocks the Dimension', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?quality=performance');
  await expect(page.locator('[data-render-ready="true"]')).toBeVisible({ timeout: 60_000 });
  const advisor = page.getByTestId('atlas-advisor');
  await expect(advisor).toBeVisible();
  await expect(advisor).toContainText('press L to link');
  await expect(advisor).toHaveAttribute('data-linked', 'false');
  // N opens the panel with plain instructions; it never claims a link that does not exist.
  await page.keyboard.press('KeyN');
  await expect(page.getByRole('region', { name: 'ATLAS advisor' })).toContainText('not linked to this session');
  await page.keyboard.press('KeyN');
  await expect(page.getByRole('region', { name: 'ATLAS advisor' })).toHaveCount(0);
  // L opens ATLAS in its own window.
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press('KeyL')]);
  await popup.close();
  // H hides the whole HUD, including the advisor, for clean presentation.
  await page.keyboard.press('KeyH');
  await expect(page.getByTestId('atlas-advisor')).toHaveCount(0);
  await page.keyboard.press('KeyH');
  await expect(page.getByTestId('atlas-advisor')).toBeVisible();
  expect(errors).toEqual([]);
});
