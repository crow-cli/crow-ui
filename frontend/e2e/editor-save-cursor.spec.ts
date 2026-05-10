import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:3928";

/**
 * Regression test: saving a file must not jump the cursor.
 *
 * Before the fix, the worktree-file-changed event (fired after save)
 * would call setModelContent() which unconditionally did model.setValue(),
 * resetting the cursor to the start of the file.
 *
 * After the fix, setModelContent() skips setValue() when the new content
 * matches the current model content, so the cursor stays put.
 */
test("save does not jump cursor", async ({ page }) => {
  await page.goto(BASE_URL);
  await page.waitForTimeout(2500); // wait for ws connect + workspace restore

  // Open an existing file via explorer click (properly sets openFiles + activeFile)
  const fileItem = page.locator("text=agent-client-design.md").first();
  await fileItem.waitFor({ timeout: 10000 });
  await fileItem.click();

  // Wait for editor to appear
  await page.waitForTimeout(800);
  const editor = page.locator('[data-testid="monaco-editor"]').first();
  await expect(editor).toBeVisible({ timeout: 5000 });

  // Click in editor and type at end of first line
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type("\n\nADDED BY TEST");

  // Wait for dirty state
  await page.waitForTimeout(300);

  // Remember cursor position from status bar before save
  const statusBar = page.locator("text=/Ln \\d+, Col \\d+/").first();
  await expect(statusBar).toBeVisible();
  const posBefore = await statusBar.textContent();
  expect(posBefore).toMatch(/Ln \d+, Col \d+/);

  // Save
  await page.keyboard.press("Control+s");

  // Wait for save + worktree-file-changed to propagate
  await page.waitForTimeout(800);

  // Verify cursor did NOT jump (status bar shows same position)
  const posAfter = await statusBar.textContent();
  expect(posAfter).toBe(posBefore);
});
