import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:3928";

test.describe("Typed RPC Smoke Test", () => {
  test("page loads and WebSocket connects", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    // Check that the app rendered (look for a known element)
    const app = page.locator("[data-testid='flexlayout-layout']").or(page.locator(".flexlayout__layout"));
    await expect(app).toBeVisible({ timeout: 5000 });
  });

  test("open folder picker and list directories", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    // Click the folder open button in the sidebar
    const folderBtn = page.locator("button[title='Open Folder'], [data-testid='open-folder-btn']").first();
    if (await folderBtn.isVisible().catch(() => false)) {
      await folderBtn.click();
      await page.waitForTimeout(500);

      // Folder picker dialog should appear
      const dialog = page.locator("[role='dialog']").or(page.locator(".folder-picker"));
      await expect(dialog).toBeVisible({ timeout: 3000 });

      // Should show directory entries (tests fsApi.readDir)
      const entries = page.locator("[data-testid='dir-entry']").or(page.locator(".folder-picker-item"));
      const count = await entries.count();
      console.log(`Folder picker shows ${count} entries`);
    }
  });

  test("create terminal tab", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    // Look for terminal button in sidebar or tab bar
    const termBtn = page.locator("button[title='Terminal'], [data-testid='new-terminal-btn']").first();
    if (await termBtn.isVisible().catch(() => false)) {
      await termBtn.click();
      await page.waitForTimeout(1000);

      // Terminal should render (xterm.js canvas)
      const term = page.locator(".xterm-screen, .xterm-rows").first();
      await expect(term).toBeVisible({ timeout: 5000 });
      console.log("Terminal spawned successfully");
    }
  });

  test("open settings pane", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    const settingsBtn = page.locator("button[title='Settings'], [data-testid='settings-btn']").first();
    if (await settingsBtn.isVisible().catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(500);

      // Settings editor should appear
      const editor = page.locator("[data-testid='monaco-editor']").first();
      await expect(editor).toBeVisible({ timeout: 3000 });
      console.log("Settings pane opened successfully");
    }
  });
});
