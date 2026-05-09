import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:3928";

test("backend settings API works end-to-end", async ({ page }) => {
  await page.goto(BASE_URL);
  await page.waitForTimeout(1500); // wait for ws connect

  // Test get_all_settings returns a nested object
  const allSettings = await page.evaluate(async () => {
    const ws = (window as any).__ws_client;
    return await ws.invoke("get_all_settings", {});
  });
  expect(allSettings).toBeDefined();
  expect(typeof allSettings).toBe("object");

  // Test get_setting returns a value (backend has its own defaults)
  const fontSize = await page.evaluate(async () => {
    const ws = (window as any).__ws_client;
    return await ws.invoke("get_setting", { key: "editor.fontSize" });
  });
  expect(typeof fontSize.value).toBe("number");
  const originalValue = fontSize.value;

  // Test update_setting persists
  await page.evaluate(async () => {
    const ws = (window as any).__ws_client;
    await ws.invoke("update_setting", { key: "editor.fontSize", value: 42 });
  });

  // Verify it changed
  const updated = await page.evaluate(async () => {
    const ws = (window as any).__ws_client;
    return await ws.invoke("get_setting", { key: "editor.fontSize" });
  });
  expect(updated.value).toBe(42);

  // Reset back to original
  await page.evaluate(async (orig) => {
    const ws = (window as any).__ws_client;
    await ws.invoke("update_setting", { key: "editor.fontSize", value: orig });
  }, originalValue);
});
