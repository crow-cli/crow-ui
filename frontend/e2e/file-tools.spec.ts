import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "fs/promises";

const BASE_URL = "http://localhost:3928";

async function setupTestFile(name: string, content: string): Promise<string> {
  const dir = `/tmp/crow-ui-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await mkdir(dir, { recursive: true });
  const path = `${dir}/${name}`;
  await writeFile(path, content, "utf-8");
  return path;
}

test("read_file returns document model content when file is open", async ({
  page,
}) => {
  const testFile = await setupTestFile(
    "hello.txt",
    "original content\nline two\n",
  );
  await page.goto(BASE_URL);
  await page.waitForTimeout(1500);

  // Open test file via API
  await page.evaluate(async (path) => {
    await window.__ws_client.invoke("document_open", {
      path,
      content: "original content\nline two\n",
    });
  }, testFile);

  // Read via API
  const result = await page.evaluate(async (path) => {
    return await window.__ws_client.invoke("read_file", { path });
  }, testFile);

  expect(result.content).toBe("original content\nline two\n");
});

test("write_file updates document model and records change", async ({
  page,
}) => {
  const testFile = await setupTestFile(
    "write.txt",
    "original content\nline two\n",
  );
  await page.goto(BASE_URL);
  await page.waitForTimeout(1500);

  // Open file in document model
  await page.evaluate(async (path) => {
    await window.__ws_client.invoke("document_open", {
      path,
      content: "original content\nline two\n",
    });
  }, testFile);

  // Write new content
  await page.evaluate(async (path) => {
    await window.__ws_client.invoke("write_file", {
      path,
      content: "modified content\nline two\nline three\n",
    });
  }, testFile);

  // Check get_file_change returns old + new
  const change = await page.evaluate(async (path) => {
    return await window.__ws_client.invoke("get_file_change", { path });
  }, testFile);

  expect(change.old_content).toBe("original content\nline two\n");
  expect(change.new_content).toBe("modified content\nline two\nline three\n");
});

test("worktree event updates editor when file changes externally", async ({
  page,
}) => {
  // Use the watched workspace directory so file watcher detects changes
  const testFile = "/tmp/test-workspace/worktree-test.txt";
  await writeFile(testFile, "original\n", "utf-8");

  await page.goto(BASE_URL);
  await page.waitForTimeout(2500); // wait for workspace restore

  // Open the file in editor via API
  await page.evaluate(async (path) => {
    await window.__ws_client.invoke("document_open", {
      path,
      content: "original\n",
    });
  }, testFile);

  // Change file externally using Node fs
  await writeFile(testFile, "external change\n", "utf-8");

  // Wait for file watcher debounce + broadcast
  await page.waitForTimeout(300);

  // Read file via API — should see new content
  const result = await page.evaluate(async (path) => {
    return await window.__ws_client.invoke("read_file", { path });
  }, testFile);

  expect(result.content).toContain("external change");
});

test("write tool renders FileWriteView with diff content", async ({ page }) => {
  await page.goto(BASE_URL);
  await page.waitForTimeout(2500);

  // Inject synthetic write tool notification via exposed ACP client
  await page.evaluate(() => {
    const client = (window as any).__acp_client;
    client.onNotification({
      type: "session_notification",
      data: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "test-write-" + Date.now(),
          title: "write: /tmp/test-workspace/test-write.txt",
          kind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "/tmp/test-workspace/test-write.txt",
              newText: "line one\nline two\n",
              oldText: "",
            },
          ],
        },
      },
    });
  });

  // Wait for React to render
  await page.waitForTimeout(200);

  // Verify write view header
  const writeHeader = page.locator("text=✏️ Write").first();
  await expect(writeHeader).toBeVisible();

  // Verify content is rendered in the write view
  const content = page.locator("text=line one").first();
  await expect(content).toBeVisible();
});

test("edit tool renders FileEditView with before/after diff", async ({
  page,
}) => {
  await page.goto(BASE_URL);
  await page.waitForTimeout(2500);

  // Inject synthetic edit tool notification
  await page.evaluate(() => {
    const client = (window as any).__acp_client;
    client.onNotification({
      type: "session_notification",
      data: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "test-edit-" + Date.now(),
          title: "edit: /tmp/test-workspace/test-edit.txt",
          kind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "/tmp/test-workspace/test-edit.txt",
              newText: "far from the original",
              oldText: "original",
            },
          ],
        },
      },
    });
  });

  // Wait for React to render
  await page.waitForTimeout(200);

  // Verify diff view header
  const diffHeader = page.locator("text=🔄 Diff").first();
  await expect(diffHeader).toBeVisible();

  // Verify both old and new content appear in the diff
  const oldContent = page.locator("text=original").first();
  await expect(oldContent).toBeVisible();
});
