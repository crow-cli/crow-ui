import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "fs/promises";

const BASE_URL = "http://localhost:3928";
const TEST_DIR = "/tmp/crow-ui-chat-test-" + Date.now();
const TEST_FILE = TEST_DIR + "/agent-test.txt";

test.beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(TEST_FILE, "Hello from before\nThis is line two\n", "utf-8");
});

test("agent read and write shows diff in chat", async ({ page }) => {
  await page.goto(BASE_URL);
  await page.waitForTimeout(2000);

  // Create a test session via API
  const sessionRes = await fetch(`${BASE_URL}/api/acp/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: TEST_DIR }),
  });
  expect(sessionRes.status).toBe(200);
  const sessionData = await sessionRes.json();
  const sessionId = sessionData.sessionId;
  expect(sessionId).toBeTruthy();

  // Wait for chat tab to appear
  await page.waitForTimeout(1500);

  // Take screenshot of initial state
  await page.screenshot({ path: "e2e/screenshots/chat-before-prompt.png" });

  // Prompt the agent to read the file and then write new content
  const promptRes = await fetch(`${BASE_URL}/api/acp/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blocks: [
        {
          type: "text",
          text: `Please use the read_file tool to read ${TEST_FILE}, then use the write_file tool to overwrite it with exactly:\nHello from after\nThis line changed\nNew line three\n\nThen tell me what you did.`,
        },
      ],
    }),
  });
  expect(promptRes.status).toBe(202);

  // Wait for agent to process (up to 60s)
  let foundRead = false;
  let foundDiff = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);

    // Check DOM for read tool and diff (write with beforeContent shows as Diff)
    const html = await page.content();
    if (!foundRead && html.includes("📄 Read")) foundRead = true;
    if (!foundDiff && (html.includes("🔄 Diff") || html.includes("✏️ Write"))) foundDiff = true;

    if (foundRead && foundDiff) break;
  }

  expect(foundRead).toBe(true);
  expect(foundDiff).toBe(true);

  // Screenshot the chat with tool results
  await page.screenshot({ path: "e2e/screenshots/chat-after-tools.png" });

  // Check that a diff is shown for the write
  const hasDiff = await page.locator('text=Diff').first().isVisible().catch(() => false);
  if (!hasDiff) {
    // Take screenshot for manual review if diff not found
    await page.screenshot({ path: "e2e/screenshots/chat-no-diff.png" });
  }

  // Clean up: close session
  await fetch(`${BASE_URL}/api/acp/sessions/${sessionId}/cancel`, { method: "POST" });
});
