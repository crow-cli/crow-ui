import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:3928";

test.describe("ACP Backend Control", () => {
  test("POST /api/acp/sessions creates session via frontend with real crow-cli agent", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2500); // wait for ws connect + workspace restore

    const result = await page.evaluate(async () => {
      const resp = await fetch("/api/acp/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/tmp" }),
      });
      return { status: resp.status, body: await resp.json() };
    });

    expect(result.status).toBe(200);
    expect(result.body.sessionId).toBeDefined();
    expect(typeof result.body.sessionId).toBe("string");

    // Verify a new chat tab was created in the UI
    await page.waitForTimeout(1000);
    const chatTabs = page.locator('.flexlayout__tab_button:text("Agent Chat")');
    const count = await chatTabs.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("POST /api/acp/sessions/:id/prompt delivers message to chat UI", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2500);

    // First create a session
    const createResult = await page.evaluate(async () => {
      const resp = await fetch("/api/acp/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/tmp" }),
      });
      return await resp.json();
    });
    const sessionId = createResult.sessionId;

    // Wait for the chat tab to appear and the session to be ready
    await page.waitForTimeout(3000);

    // Send a prompt via the API
    const promptResult = await page.evaluate(async (sid) => {
      const resp = await fetch(`/api/acp/sessions/${sid}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks: [{ type: "text", text: "Hello from API test" }] }),
      });
      return { status: resp.status, body: await resp.json() };
    }, sessionId);

    expect(promptResult.status).toBe(202);
    expect(promptResult.body.status).toBe("queued");

    // Verify the prompt appears in the chat UI
    await page.waitForTimeout(500);
    const chatMessage = page.locator('text=Hello from API test');
    await expect(chatMessage).toBeVisible();
  });

  test("full flow: create session, prompt, and receive agent response", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2500);

    // Create session
    const createResult = await page.evaluate(async () => {
      const resp = await fetch("/api/acp/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/home/thomas/src/crow-ai/murder-sidex" }),
      });
      return await resp.json();
    });
    const sessionId = createResult.sessionId;

    // Wait for session to connect
    await page.waitForTimeout(5000);

    // Send prompt
    await page.evaluate(async (sid) => {
      await fetch(`/api/acp/sessions/${sid}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks: [{ type: "text", text: "Say exactly: API_TEST_PONG" }] }),
      });
    }, sessionId);

    // Wait for agent response
    await page.waitForTimeout(8000);

    // Verify the response appears in chat (use exact match to avoid matching the prompt or thinking text)
    const responseText = page.getByText('API_TEST_PONG', { exact: true });
    await expect(responseText).toBeVisible();
  });

  test("POST /api/acp/sessions/:id/cancel returns accepted", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    const result = await page.evaluate(async () => {
      const resp = await fetch("/api/acp/sessions/test-session/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      return { status: resp.status, body: await resp.json() };
    });

    expect(result.status).toBe(202);
    expect(result.body.status).toBe("queued");
  });

  test("terminal tool renders output in chat inline terminal", async ({
    page,
  }, testInfo) => {
    // Use a large viewport so the chat pane has room to render terminals
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(BASE_URL);
    await page.waitForTimeout(2500);

    // Create session with the murder-sidex workspace so agent has files to work with
    const createResult = await page.evaluate(async () => {
      const resp = await fetch("/api/acp/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/home/thomas/src/crow-ai/murder-sidex" }),
      });
      return await resp.json();
    });
    const sessionId = createResult.sessionId;

    // Wait for session to connect and chat tab to appear
    await page.waitForTimeout(5000);

    // Take screenshot before prompt — clean chat state
    await page.screenshot({
      path: `${testInfo.outputDir}/terminal-test-01-before-prompt.png`,
    });

    // Send a prompt that will trigger a terminal tool
    await page.evaluate(async (sid) => {
      await fetch(`/api/acp/sessions/${sid}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blocks: [
            {
              type: "text",
              text: 'Run the command `echo "TERMINAL_RENDER_TEST"` in the terminal and tell me what it printed.',
            },
          ],
        }),
      });
    }, sessionId);

    // Wait for agent to start thinking and potentially use terminal
    await page.waitForTimeout(4000);

    // Take screenshot while agent is working — should show thinking + terminal
    await page.screenshot({
      path: `${testInfo.outputDir}/terminal-test-02-mid-execution.png`,
    });

    // Wait for terminal execution to complete and xterm to render
    await page.waitForTimeout(8000);

    // Scroll to ensure the terminal tool call is visible before screenshot
    const terminalTool = page
      .locator("[data-testid='chat-pane']")
      .locator("text=$ echo")
      .first();
    if (await terminalTool.isVisible().catch(() => false)) {
      await terminalTool.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    }

    // Take screenshot after execution — terminal should show output
    await page.screenshot({
      path: `${testInfo.outputDir}/terminal-test-03-after-execution.png`,
    });

    // Verify the terminal output appears in the chat UI.
    // The xterm.js terminal renders the output in a span inside the terminal canvas.
    const terminalOutput = page
      .locator(".xterm-screen, .xterm-rows")
      .getByText("TERMINAL_RENDER_TEST", { exact: false });
    await expect(terminalOutput).toBeVisible();

    // Also verify the agent mentions the output in its response
    const agentResponse = page
      .locator("[data-testid='chat-pane'] p")
      .filter({ hasText: /TERMINAL_RENDER_TEST/i })
      .first();
    await expect(agentResponse).toBeVisible();
  });
});
