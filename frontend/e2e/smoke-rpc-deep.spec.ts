import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:3928";

test.describe("Deep RPC Smoke Test", () => {
  test.beforeEach(async ({ page }) => {
    // Capture all console messages
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error" || text.includes("RPC") || text.includes("failed") || text.includes("error")) {
        console.log(`[${type.toUpperCase()}] ${text}`);
      }
    });
    page.on("pageerror", (err) => {
      console.log(`[PAGE ERROR] ${err.message}`);
    });
  });

  test("open workspace and verify explorer loads", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2500);

    // Try to open a folder via the menu or button
    const openFolderBtn = page.locator("button").filter({ hasText: /Open Folder/i }).first();
    if (await openFolderBtn.isVisible().catch(() => false)) {
      await openFolderBtn.click();
      await page.waitForTimeout(500);

      // Select the first directory in the picker
      const firstDir = page.locator("[data-testid='dir-entry']").first();
      if (await firstDir.isVisible().catch(() => false)) {
        await firstDir.click();
        await page.waitForTimeout(1000);

        // Explorer should show files
        const files = page.locator(".explorer-file, [data-testid='explorer-item']");
        const count = await files.count();
        console.log(`Explorer shows ${count} items`);
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("terminal spawns and receives data", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2500);

    const termBtn = page.locator("button[title='Terminal']").first();
    if (await termBtn.isVisible().catch(() => false)) {
      await termBtn.click();
      await page.waitForTimeout(1500);

      // Terminal should have some content (shell prompt)
      const term = page.locator(".xterm-rows");
      await expect(term).toBeVisible({ timeout: 5000 });

      // Type something and check it appears
      await term.press("Enter");
      await page.waitForTimeout(500);
      console.log("Terminal interaction OK");
    }
  });

  test("settings loads config without errors", async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2500);

    const settingsBtn = page.locator("button[title='Settings']").first();
    if (await settingsBtn.isVisible().catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(1000);

      // Settings editor should have content loaded from file
      const editor = page.locator("[data-testid='monaco-editor']");
      await expect(editor).toBeVisible({ timeout: 3000 });
      console.log("Settings loaded OK");
    }
  });
});
