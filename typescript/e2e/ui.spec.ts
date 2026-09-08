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
