import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:3928";

/**
 * Regression test: dirty indicator shows in bottom bar and clears on save.
 *
 * Before the fix, dirty state was never cleared because handleDirtyChange
 * only added to the dirty set but never removed. Also, openFiles was not
 * populated during workspace restore, so currentFile was undefined and the
 * bottom bar never showed the dirty dot.
 */
test("dirty indicator shows and clears on save", async ({ page }) => {
  await page.goto(BASE_URL);
  await page.waitForTimeout(2500); // wait for ws connect + workspace restore

  // Open an existing file via explorer click
  const fileItem = page.locator("text=agent-client-design.md").first();
  await fileItem.waitFor({ timeout: 10000 });
  await fileItem.click();

  // Wait for editor
  await page.waitForTimeout(800);
  const editor = page.locator('[data-testid="monaco-editor"]').first();
  await expect(editor).toBeVisible({ timeout: 5000 });

  // Initially no dirty dot
  const dirtyDot = page.locator('[data-testid="dirty-dot"]');
  await expect(dirtyDot).toHaveCount(0);

  // Type to make dirty
  await editor.click();
  await page.keyboard.type("// DIRTY TEST");

  // Wait for debounce (300ms) + render
  await page.waitForTimeout(500);

  // Dirty dot should appear in bottom bar
  await expect(dirtyDot).toHaveCount(1);

  // Save
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(800);

  // Dirty dot should disappear
  await expect(dirtyDot).toHaveCount(0);
});
