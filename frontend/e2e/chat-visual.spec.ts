import { test, expect } from "@playwright/test";

const BASE_URL = process.env.crow_ui_URL || "http://localhost:3928";

/**
 * Visual regression tests for ChatPane cyberpunk styling.
 *
 * Prerequisites:
 *   - crow-ui-server is running (auto-restores a workspace)
 *   - ACP agent may be disconnected (we inject fake content for visual testing)
 */

test.describe("ChatPane Visual", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    // Wait for auto-restore to settle
    await page.waitForTimeout(2500);
  });

  test("chat panel is transparent with glass header", async ({ page }) => {
    const chat = page.locator('[data-testid="chat-pane"]').first();
    await expect(chat).toBeVisible();

    const header = chat.locator("div").first();
    await expect(header).toBeVisible();

    await chat.screenshot({ path: "e2e/screenshots/01-chat-pane-glass.png" });
  });

  test("markdown renders with cyberpunk styling", async ({ page }) => {
    const chat = page.locator('[data-testid="chat-pane"]').first();
    const messages = chat.locator('[data-testid="chat-messages"]').first();
    await expect(messages).toBeVisible();

    // Inject synthetic markdown for visual testing
    await messages.evaluate((el) => {
      el.innerHTML = `
        <div style="margin-bottom:8px" class="flex justify-end">
          <div class="ml-auto max-w-[70%] px-3 py-2 bg-violet-500/10 border border-violet-500/20 rounded-xl rounded-br-sm text-[13px] text-text-primary backdrop-blur-sm shadow-[0_0_12px_rgba(139,92,246,0.08)]">
            Write a function to calculate fibonacci
          </div>
        </div>
        <div class="w-full px-4 py-3 text-[13px] leading-relaxed text-text-primary">
          <h1>Fibonacci Function</h1>
          <p>Here's a recursive implementation with memoization:</p>
          <pre><code class="language-python">def fibonacci(n, memo={}):
    if n in memo:
        return memo[n]
    if n <= 1:
        return n
    memo[n] = fibonacci(n - 1, memo) + fibonacci(n - 2, memo)
    return memo[n]</code></pre>
          <p>You can also use an <code>iterative</code> approach for better performance:</p>
          <blockquote><p>Time complexity: O(n), Space complexity: O(1)</p></blockquote>
          <ul><li>Fast</li><li>Memory efficient</li><li>Easy to understand</li></ul>
          <hr/>
          <p>See the <a href="#">documentation</a> for more details.</p>
        </div>
      `;
    });

    // Wait for layout
    await page.waitForTimeout(500);

    await messages.screenshot({ path: "e2e/screenshots/02-chat-markdown.png" });
  });

  test("grid background visible through panels", async ({ page }) => {
    // Screenshot full viewport to verify grid shows through glass panels
    await page.screenshot({
      path: "e2e/screenshots/03-full-app-grid.png",
      fullPage: false,
    });
  });

  test("message editor has glass styling", async ({ page }) => {
    const chat = page.locator('[data-testid="chat-pane"]').first();
    // Message editor is the last child of chat pane
    const editor = chat.locator("div").last();
    await expect(editor).toBeVisible();

    await editor.screenshot({ path: "e2e/screenshots/04-message-editor.png" });
  });
});
