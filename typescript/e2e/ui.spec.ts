import { test, expect } from "@playwright/test";
test("device-mode selection uses only advertised MJPEG modes (hardware response fixture)", async ({
  page,
}) => {
  // Hold discovery until the menu is open, reproducing the CI race without
  // relying on runner speed or an arbitrary sleep.
  let releaseStatus!: () => void;
  let statusMessage: string | null = null;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const modes = [
      { width: 1920, height: 1080, fps: 30, pixel_format: "MJPG" },
      { width: 1280, height: 720, fps: 60, pixel_format: "MJPG" },
    ];
    data.source = {
      backend: "v4l2",
      source_id: "v4l2:/dev/video0",
      health: "available",
      capabilities: [modes[0]],
      error: null,
    };
    data.v4l2 = {
      status: "ok",
      devices: [
        {
          device_path: "/dev/video0",
          display_name: "UVC fixture",
          node_kind: "video_capture",
          driver: "uvcvideo",
          supports_video_capture: true,
          capabilities: modes,
        },
      ],
    };
    await statusGate;
    data.source.error = statusMessage;
    await route.fulfill({ json: data });
  });
  await page.route("**/api/video-settings", (route) =>
    route.fulfill({ json: { video: route.request().postDataJSON() } }),
  );
  try {
    await page.locator("#refresh-button").click();
    await page.locator("#screen-button").click();
    await expect(page.locator("#resolution-select")).toBeDisabled();
    releaseStatus();
    await expect(page.locator("#resolution-select")).toHaveValue("1920x1080");
    await page.locator("#resolution-select").selectOption("1280x720");
    await expect(page.locator("#refresh-rate-select")).toHaveValue("60");
    // The next status poll must not reset the user's unapplied selection.
    statusMessage = "unchanged capabilities";
    await expect(page.locator("#info-error")).toHaveText(statusMessage, {
      timeout: 10000,
    });
    await expect(page.locator("#resolution-select")).toHaveValue("1280x720");
    await expect(page.locator("#refresh-rate-select")).toHaveValue("60");
    const update = page.waitForRequest((r) =>
      r.url().endsWith("/api/video-settings"),
    );
    await page.locator("#apply-screen-settings").click();
    expect((await update).postDataJSON()).toEqual({
      width: 1280,
      height: 720,
      fps: 60,
    });
  } finally {
    releaseStatus();
  }
});
test("disconnected HID disables screen keyboard and failed video shows No Signal", async ({
  page,
}) => {
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.hid = { enabled: false, backend: "linux-auto", state: "disconnected" };
    data.source.health = "unavailable";
    data.stream = {
      state: "error",
      sequence: null,
      error: "test capture disconnected",
      message: "No Signal",
    };
    await route.fulfill({ json: data });
  });
  await page.route("**/api/stream.mjpg*", (route) =>
    route.fulfill({ status: 503, body: "No Signal" }),
  );
  await page.locator("#refresh-button").click();
  await expect(page.locator("#no-signal")).toBeVisible();
  await page.locator("#keyboard-button").click();
  await expect(page.locator('[data-key="a"]')).toBeDisabled();
});
test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#video-frame")).toHaveClass(/visible/);
});

test.afterEach(async ({ page }) => {
  // Applying settings and periodic polls may still be inside route.fetch/json
  // after the last assertion. Drain handlers before Playwright disposes their
  // API responses and browser context, preserving any real handler errors.
  await page.unrouteAll({ behavior: "wait" });
});

test("a delayed startup idle status cannot hide a decoded live frame", async ({
  page,
}) => {
  let releaseStatus!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.stream = { state: "idle", sequence: null, error: null };
    data.source.error = "delayed startup status";
    await gate;
    await route.fulfill({ json: data });
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    // The status response is still held: only a real decoded image can show video.
    await expect(page.locator("#video-frame")).toHaveClass(/visible/);
    expect(
      await page
        .locator("#video-frame")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBe(1280);
    releaseStatus();
    await expect(page.locator("#info-error")).toHaveText(
      "delayed startup status",
    );
    await expect(page.locator("#video-frame")).toHaveClass(/visible/);
    await expect(page.locator("#no-signal")).toBeHidden();
  } finally {
    releaseStatus();
  }
});
test("original KVM toolbar, zoom, screen keyboard, sticky combinations, pointer and settings", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const toolbar = await page.locator(".topbar").boundingBox();
  await page.locator("#zoom-in").click();
  await page.locator("#zoom-in").click();
  expect(await page.locator(".topbar").boundingBox()).toEqual(toolbar);
  await page.locator("#keyboard-button").click();
  await expect(page.locator("#onscreen-keyboard")).toBeVisible();
  const tap = page.waitForRequest((r) => r.url().endsWith("/api/hid/key"));
  await page.locator('[data-key="a"]').click();
  expect((await tap).postDataJSON()).toEqual({ key: "a", modifiers: [] });
  await page.locator("#sticky-keys").click();
  await page.locator('[data-modifier="ctrl"]').click();
  await page.locator('[data-key="c"]').click();
  const combination = page.waitForRequest((r) =>
    r.url().endsWith("/api/hid/key"),
  );
  await page.locator("#sticky-keys").click();
  expect((await combination).postDataJSON()).toEqual({
    key: "c",
    modifiers: ["ctrl"],
  });
  await page.locator("#close-keyboard").click();
  await expect(page.locator("#onscreen-keyboard")).toBeHidden();
  const mouse = page.waitForRequest((r) =>
    r.url().endsWith("/api/hid/mouse-position"),
  );
  await page.mouse.move(500, 450);
  const position = (await mouse).postDataJSON();
  expect(position.x).toBeGreaterThanOrEqual(0);
  expect(position.x).toBeLessThanOrEqual(32767);
  const click = page.waitForRequest((r) =>
    r.url().endsWith("/api/hid/mouse-click"),
  );
  await page.mouse.click(500, 450, { button: "right" });
  expect((await click).postDataJSON().button).toBe("right");
  await page.locator("#settings-button").click();
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#info-backend")).toHaveText("synthetic");
  await page.locator("#close-settings").click();
  await page.locator("#screen-button").click();
  await expect(page.locator("#screen-menu")).toBeVisible();
  await expect(page.locator("#resolution-select")).toBeDisabled();
  await expect(page.locator("#screen-message")).toHaveText(
    "当前视频源不支持调整",
  );
  await page.locator("#screen-button").click();
  await page.locator("#refresh-button").click();
  await expect(page.locator("#video-frame")).toHaveClass(/visible/);
  await page.screenshot({ path: "work/e2e-kvm.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("Agent observation, approval and rejection, persisted sessions, return to live video", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#agent-mode-button").click();
  await expect(page.locator("body")).toHaveClass(/agent-mode/);
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/status")).json()).stream.state,
    )
    .toBe("idle");
  await page.locator("#new-agent-chat").click();
  await page.locator("#agent-input").fill("看看当前画面");
  await page.locator("#agent-send").click();
  await expect(
    page.locator(".agent-plan").last().locator(".plan-status"),
  ).toHaveText("已完成");
  await expect(page.locator(".agent-plan").last()).toContainText(
    "test_pattern",
  );
  await page.locator("#agent-input").fill("按下回车");
  await page.locator("#agent-send").click();
  const plan = page.locator(".agent-plan").last();
  await expect(plan.locator(".plan-status")).toHaveText("等待批准");
  await plan.locator('[data-plan-action="approve"]').click();
  await expect(plan.locator(".plan-status")).toHaveText("已完成");
  await page.locator("#agent-input").fill("按下 Win");
  await page.locator("#agent-send").click();
  await page.locator('[data-plan-action="reject"]').last().click();
  await expect(
    page.locator(".agent-plan").last().locator(".plan-status"),
  ).toHaveText("已拒绝");
  await page.screenshot({ path: "work/e2e-agent.png", fullPage: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#agent-mode-button").click();
  await expect(page.locator("#agent-conversation")).toContainText("按下回车");
  await page.locator("#agent-mode-button").click();
  await expect(page.locator("#video-frame")).toHaveClass(/visible/);
  expect(errors).toEqual([]);
});
test("remote model and PC Agent configuration cards keep original interactions", async ({
  page,
}) => {
  await page.locator("#agent-mode-button").click();
  await page.locator("#agent-model-button").click();
  await page.locator('[data-config-model="remote-api"]').click();
  await expect(
    page.locator('[data-remote-field="api_key"]').last(),
  ).toHaveAttribute("type", "password");
  await expect(page.locator('[data-remote-field="model"]').last()).toHaveValue(
    "deepseek-v4-flash",
  );
  await expect(
    page.locator('[data-remote-field="vision_model"]').last(),
  ).toHaveValue("deepseek-v4-flash-vision-exp");
  await page.locator("#agent-model-button").click();
  await page.locator('[data-config-model="pc-agent"]').click();
  await expect(page.locator("[data-setup-action]").last()).toBeVisible();
});
test("mobile toolbar and Agent sidebar remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#agent-mode-button").click();
  await page.locator("#agent-sidebar-toggle").click();
  await expect(page.locator(".agent-app")).toHaveClass(/sidebar-open/);
  await page.locator("#new-agent-chat").click();
  await expect(page.locator("#agent-input")).toBeVisible();
  await page.screenshot({ path: "work/e2e-mobile.png", fullPage: true });
});

test("failed setup can be retried with a fresh task and cancelled from the UI", async ({
  page,
  request,
}) => {
  await page.locator("#agent-mode-button").click();
  await page.locator("#agent-model-button").click();
  await page.locator('[data-config-model="pc-agent"]').click();
  await page.locator('[data-setup-action="start"]').click();
  await expect(page.locator("#agent-conversation")).toContainText(
    "无法启动配置",
  );
  await expect(page.locator('[data-setup-action="start"]')).toHaveText(
    "检查后重试",
  );
  const first = (
    await (await request.get("/api/model-setup/tasks/latest")).json()
  ).task;
  expect(first.status).toBe("failed");
  const retry = page.waitForResponse((r) =>
    r.url().endsWith("/api/model-setup/launch"),
  );
  await page.locator('[data-setup-action="start"]').click();
  await retry;
  await expect(page.locator(".model-setup-status")).toContainText("配置失败");
  const next = (
    await (await request.get("/api/model-setup/tasks/latest")).json()
  ).task;
  expect(next.task_id).not.toBe(first.task_id);
  expect(
    (
      await (
        await request.get(`/api/model-setup/tasks/${first.task_id}`)
      ).json()
    ).task.status,
  ).toBe("cancelled");
  await page.locator('[data-setup-action="cancel"]').click();
  await expect(page.locator(".model-setup-status")).toContainText("已取消");
  await expect(page.locator("[data-setup-action]")).toHaveCount(0);
});

test("conflicting session edits preserve both the remote version and a local copy", async ({
  page,
  request,
}) => {
  const id = "conflict-" + Date.now();
  const initial = {
    id,
    title: "原会话",
    createdAt: 1,
    updatedAt: 1,
    messages: [{ role: "user", content: "原消息" }],
  };
  const saved = (
    await (
      await request.post("/api/agent/sessions", { data: { session: initial } })
    ).json()
  ).session;
  await page.evaluate(
    (session) =>
      localStorage.setItem(
        "agent-ip-kvm.sessions.v1",
        JSON.stringify({
          activeId: session.id,
          sessions: [session],
          deletedIds: [],
        }),
      ),
    saved,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#agent-mode-button").click();
  await expect(page.locator("#agent-chat-title")).toHaveText("原会话");
  // Intercept only the next save and commit a competing edit before it reaches
  // the server. This deterministically reproduces a two-browser conflict.
  let competed = false;
  await page.route("**/api/agent/sessions", async (route) => {
    if (
      !competed &&
      route.request().method() === "POST" &&
      route.request().postDataJSON().session.id === id &&
      route.request().postDataJSON().session.title === "本地修改"
    ) {
      competed = true;
      const all = await (await request.get("/api/agent/sessions")).json();
      const latest = all.sessions.find((s: { id: string }) => s.id === id);
      await request.post("/api/agent/sessions", {
        data: {
          session: {
            ...latest,
            title: "远端修改",
            messages: [{ role: "user", content: "远端新消息" }],
          },
        },
      });
    }
    await route.continue();
  });
  page.once("dialog", (dialog) => dialog.accept("本地修改"));
  await page
    .locator(".session-item")
    .filter({ hasText: "原会话" })
    .locator('[data-session-action="rename"]')
    .click();
  await expect(page.locator("#agent-chat-title")).toContainText("本地冲突副本");
  await expect
    .poll(async () =>
      (await (await request.get("/api/agent/sessions")).json()).sessions.some(
        (s: { title: string }) => s.title.includes("本地冲突副本"),
      ),
    )
    .toBe(true);
  const all = (await (await request.get("/api/agent/sessions")).json())
    .sessions;
  expect(all.find((s: { id: string }) => s.id === id).messages[0].content).toBe(
    "远端新消息",
  );
  expect(
    all.find((s: { title: string }) => s.title.includes("本地冲突副本"))
      .messages[0].content,
  ).toBe("原消息");
});

test("session sync failure is visible and a later retry clears it", async ({
  page,
  request,
}) => {
  await page.route("**/api/agent/sessions", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 503, json: { error: "暂时无法保存" } })
      : route.continue(),
  );
  await page.locator("#agent-mode-button").click();
  await page.locator("#new-agent-chat").click();
  await expect(page.locator("#session-sync-status")).toContainText("未同步");
  const id = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("agent-ip-kvm.sessions.v1")!).activeId,
  );
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator("#session-sync-status")).toBeHidden({
    timeout: 10000,
  });
  const saved = (
    await (await request.get("/api/agent/sessions")).json()
  ).sessions.find((s: { id: string }) => s.id === id);
  expect(saved.revision).toBeGreaterThan(0);
});
