import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);
const {
  chromium,
} = require("C:/Users/Borinio/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const root = process.cwd();
const runtime = path.join(root, ".runtime");
const screenshotDir = path.join(runtime, "screenshots");
await fs.mkdir(screenshotDir, { recursive: true });
const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3037";
const password = (
  await fs.readFile(path.join(runtime, "owner-password.txt"), "utf8")
).trim();
const run = new Date()
  .toISOString()
  .replace(/[^0-9]/g, "")
  .slice(0, 14);
const results = [];
const browserErrors = [];
const apiErrors = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  acceptDownloads: true,
});
const page = await context.newPage();
const navigate = url =>
  page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
page.setDefaultTimeout(30000);
page.on("pageerror", error => browserErrors.push(error.message));
page.on("response", async response => {
  if (
    response.status() < 400 ||
    !response.url().includes("/api/trpc/") ||
    response.url().includes("auth.")
  )
    return;
  try {
    const body = await response.json();
    const items = Array.isArray(body) ? body : [body];
    for (const item of items) {
      const message = item.error?.json?.message ?? item.error?.message;
      if (message)
        apiErrors.push({
          procedure: new URL(response.url()).pathname.split("/").pop(),
          status: response.status(),
          message,
        });
    }
  } catch {}
});
const check = (name, condition, detail) => {
  if (!condition)
    throw new Error(`FAILED: ${name}${detail ? " — " + detail : ""}`);
  results.push({ name, passed: true, ...(detail ? { detail } : {}) });
  console.log(`PASS ${name}`);
};
const step = async (name, action) => {
  console.log(`STEP ${name}`);
  return await action();
};
async function waitText(text, timeout = 15000) {
  await page
    .getByText(text, { exact: true })
    .first()
    .waitFor({ state: "visible", timeout });
}
async function screenshot(name) {
  await page.screenshot({
    path: path.join(screenshotDir, name + ".png"),
    fullPage: true,
  });
}
async function importList(transport) {
  await navigate(base + "/recipients");
  const name = `qa-${transport}-${run}.csv`;
  const csv =
    'name,chat_id\n"Valid, A",111234567\nGroup,-1001234567890\nBad,order 123456789012\nUsername,@Alice\nDuplicate,111234567\n';
  await page
    .getByLabel("Файл получателей")
    .setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByLabel("Тип данных").selectOption("auto");
  await page.getByLabel("Кому разрешены сообщения").selectOption(transport);
  await page
    .getByLabel("Источник разрешения на сообщения")
    .fill(`Synthetic QA consent ${run}`);
  await page.getByLabel(/Эти люди согласились/).check();
  await page
    .getByRole("button", { name: "Сохранить 3 получателей", exact: true })
    .waitFor();
  check(
    `${transport} typed preview rejects prose, dedupes and preserves sign`,
    (await page
      .getByText("-1001234567890 (chat_id)", { exact: true })
      .count()) === 1
  );
  check(
    `${transport} invalid import visible`,
    await page
      .getByText("1 строк будут исключены — показать", { exact: true })
      .isVisible()
  );
  await page
    .getByRole("button", { name: "Сохранить 3 получателей", exact: true })
    .click();
  await page.getByText(name, { exact: true }).waitFor({ state: "visible" });
  await page
    .getByRole("button", {
      name: "Перетащите файл или выберите его",
      exact: false,
    })
    .waitFor({ state: "visible" });
  check(`${transport} scoped consent import saved`, true);
  return name;
}
async function dryRun(transport, listName) {
  const route = transport === "bot" ? "/launch" : "/user-broadcast";
  await navigate(base + route);
  const newButton = page.getByRole("button", {
    name: "Подготовить следующую кампанию",
    exact: true,
  });
  if (await newButton.isVisible()) await newButton.click();
  const name = `QA ${transport} ${run}`;
  await page.getByLabel("Название кампании", { exact: true }).fill(name);
  const optionValue = await page
    .getByLabel(/^Аудитория/)
    .locator("option")
    .filter({ hasText: listName })
    .getAttribute("value");
  await page.getByLabel(/^Аудитория/).selectOption(optionValue);
  await page
    .locator(`#campaign-message-${transport}`)
    .fill(`<b>QA ${transport}</b> — synthetic test ${run}`);
  check(
    `${transport} dry-run is default`,
    await page.getByLabel("Проверка без отправки", { exact: false }).isChecked()
  );
  await page
    .getByRole("button", { name: "Проверить кампанию", exact: true })
    .click();
  await page
    .getByText(/^Кампания #\d+$/)
    .waitFor({ state: "visible", timeout: 30000 });
  const url = new URL(page.url());
  check(
    `${transport} campaign ID persists in URL`,
    /^\d+$/.test(url.searchParams.get("campaign") || "")
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(/^Кампания #\d+$/).waitFor();
  await waitText("Завершена", 120000);
  check(`${transport} dry-run completes after reload`, true);
  const stats = page.locator("section").filter({ hasText: /^Кампания #/ });
  const checked = stats
    .locator("div")
    .filter({ has: page.getByText("Проверено", { exact: true }) })
    .last();
  check(
    `${transport} dry-run count shown`,
    (await checked.innerText()).includes("3")
  );
  const accepted = stats
    .locator("div")
    .filter({ has: page.getByText("Принято Telegram", { exact: true }) })
    .last();
  check(
    `${transport} no actual accepted sends`,
    (await accepted.innerText()).includes("0")
  );
  await page.getByRole("button", { name: "Отчёт", exact: false }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
  await page.locator("table tbody tr").first().waitFor();
  check(
    `${transport} report has all recipients`,
    (await page.locator("table tbody tr").count()) === 3
  );
  check(
    `${transport} report labels dry run honestly`,
    (await page
      .locator("table")
      .getByText("Проверено без отправки", { exact: true })
      .count()) === 3
  );
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON", exact: false }).click();
  const download = await downloadEvent;
  const downloaded = await download.path();
  const report = JSON.parse(await fs.readFile(downloaded, "utf8"));
  check(
    `${transport} full export includes all records`,
    report.logs.length === 3 &&
      report.logs.every(item => item.status === "dry_run")
  );
  await fs.copyFile(
    downloaded,
    path.join(runtime, `qa-${transport}-report.json`)
  );
  return page.url();
}
let success = false;
try {
  await step("login", async () => {
    await navigate(base);
    await page
      .getByRole("heading", { name: "Вход владельца", exact: true })
      .waitFor();
    check(
      "anonymous user sees only login",
      (await page
        .getByRole("link", { name: "Все кампании", exact: true })
        .count()) === 0
    );
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page
      .getByRole("heading", {
        name: "Меньше рутины. Больше контроля.",
        exact: true,
      })
      .waitFor({ timeout: 30000 });
    check("owner login works", true);
    await page
      .getByText("Активен", { exact: true })
      .waitFor({ timeout: 45000 });
    check("worker heartbeat visible", true);
    await screenshot("01-dashboard-desktop");
  });
  const botList = await step("import bot CSV", () => importList("bot"));
  const accountList = await step("import MTProto CSV", () =>
    importList("mtproto")
  );
  await step("XLSX explicit sheet and column", async () => {
    await navigate(base + "/recipients");
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Orders").addRows([["order"], ["123456789012"]]);
    workbook.addWorksheet("Audience").addRows([
      ["name", "chat_id"],
      ["Group", "-1001234567890"],
      ["User", "123456789"],
      ["Invalid", "order 123456789012"],
    ]);
    await page.getByLabel("Файл получателей").setInputFiles({
      name: `qa-workbook-${run}.xlsx`,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    });
    await page.getByLabel("Лист").selectOption("1");
    await page.getByLabel("Колонка получателей").selectOption("1");
    await page.getByLabel("Тип данных").selectOption("chat_id");
    await page.getByLabel("Первая строка — заголовок").check();
    await page
      .getByRole("button", { name: "Сохранить 2 получателей", exact: true })
      .waitFor();
    check("XLSX parses selected sheet/column only", true);
    check(
      "XLSX preserves group minus",
      await page
        .getByText("-1001234567890 (chat_id)", { exact: true })
        .isVisible()
    );
    await page
      .getByRole("button", { name: "Закрыть импорт", exact: true })
      .click();
  });
  await step("draft persistence and safe preview", async () => {
    await navigate(base + "/composer");
    const message = `<b>QA draft ${run}</b>\n<img src=x onerror="window.__previewXss=true">\n<a href='javascript:alert(1)'>unsafe URL</a>`;
    await page.getByLabel("Текст сообщения", { exact: true }).fill(message);
    await page
      .getByText(/^Сохранено · версия \d+$/)
      .waitFor({ timeout: 30000 });
    check(
      "preview does not create malicious image",
      (await page.locator("main img").count()) === 0
    );
    check(
      "preview never executes handler",
      !(await page.evaluate(() => window.__previewXss))
    );
    check(
      "preview blocks javascript URL",
      (await page.locator('main a[href^="javascript:"]').count()) === 0
    );
    await navigate(base + "/launch");
    await page.locator("#campaign-message-bot").waitFor();
    await page.waitForFunction(
      expected =>
        document.querySelector("#campaign-message-bot")?.value === expected,
      message
    );
    check(
      "draft survives navigation",
      (await page.locator("#campaign-message-bot").inputValue()) === message
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      expected =>
        document.querySelector("#campaign-message-bot")?.value === expected,
      message
    );
    check("draft survives full reload", true);
    await screenshot("02-draft-desktop");
  });
  await step("draft conflict preserves local text", async () => {
    await navigate(base + "/composer");
    await page.getByText(/^Сохранено · версия \d+$/).waitFor();
    const second = await context.newPage();
    second.setDefaultTimeout(30000);
    try {
      await second.goto(base + "/composer", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await second.getByText(/^Сохранено · версия \d+$/).waitFor();
      const accepted = `QA version A ${run}`;
      const conflicting = `QA unsaved version B ${run}`;
      await page.getByLabel("Текст сообщения", { exact: true }).fill(accepted);
      await page.getByText(/^Сохранено · версия \d+$/).waitFor();
      await second
        .getByLabel("Текст сообщения", { exact: true })
        .fill(conflicting);
      await second
        .getByRole("alert")
        .filter({ hasText: "Черновик изменён" })
        .waitFor();
      check(
        "conflicting tab retains its text",
        (await second
          .getByLabel("Текст сообщения", { exact: true })
          .inputValue()) === conflicting
      );
      check(
        "conflict cannot silently retry overwrite",
        await second
          .getByRole("button", { name: "Повторить сохранение", exact: true })
          .isDisabled()
      );
      second.once("dialog", dialog => dialog.accept());
      await second
        .getByRole("button", { name: "Загрузить с сервера", exact: true })
        .click();
      await second.waitForFunction(
        expected => document.querySelector("#message")?.value === expected,
        accepted
      );
      check("server draft keeps first accepted version", true);
    } finally {
      await second.close();
    }
  });
  const botReport = await step("bot dry-run", () => dryRun("bot", botList));
  await screenshot("03-report-desktop");
  await step("mobile report and navigation", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await navigate(botReport);
    await page.locator("table tbody tr").first().waitFor();
    check(
      "mobile viewport has no page overflow",
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    );
    await page
      .getByRole("button", { name: "Открыть меню", exact: true })
      .click();
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Все кампании", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Все кампании", exact: true })
      .waitFor();
    check("mobile sidebar navigation works", true);
    await screenshot("04-history-mobile-390");
    await page.setViewportSize({ width: 1440, height: 1024 });
  });
  await step("MTProto dry-run", () => dryRun("mtproto", accountList));
  await step("approved automation", async () => {
    await navigate(base + "/autopilot");
    await page
      .getByRole("button", { name: "Новый сценарий", exact: true })
      .click();
    const name = `QA schedule ${run}`;
    await page.getByLabel("Название", { exact: true }).fill(name);
    const value = await page
      .getByLabel(/^Аудитория/)
      .locator("option")
      .filter({ hasText: botList })
      .getAttribute("value");
    await page.getByLabel(/^Аудитория/).selectOption(value);
    await page.getByLabel("Интервал, минут", { exact: true }).fill("5");
    await page
      .getByLabel("Утверждаемый текст", { exact: true })
      .fill(`QA approved schedule ${run}`);
    await page
      .getByLabel(
        /Утверждаю этот текст, аудиторию и правило повторных запусков/
      )
      .check();
    await page
      .getByRole("button", {
        name: "Создать утверждённый сценарий",
        exact: true,
      })
      .click();
    const row = page.locator("article").filter({ hasText: name });
    await row.waitFor({ timeout: 30000 });
    check(
      "approved dry-run schedule created",
      await row.getByText(/Без отправки/).isVisible()
    );
    await row
      .getByRole("button", { name: "Приостановить", exact: true })
      .click();
    await row.getByRole("button", { name: "Включить", exact: true }).waitFor();
    check("automation can be paused", true);
    await screenshot("05-autopilot-desktop");
  });
  await step("approved CRM source and revocation", async () => {
    await navigate(base + "/recipients");
    const card = page
      .getByText(botList, { exact: true })
      .locator("..")
      .locator("..")
      .locator("..");
    await card.locator("summary").filter({ hasText: "Подключить CRM" }).click();
    await card.getByLabel("Название источника").fill(`QA source ${run}`);
    await card.getByLabel(/Разрешаю этому источнику добавлять/).check();
    await card
      .getByRole("button", { name: "Подключить источник", exact: true })
      .click();
    const secret = card.getByLabel("Секрет источника", { exact: true });
    await secret.waitFor();
    check(
      "CRM source returns secret only in password field",
      (await secret.getAttribute("type")) === "password" &&
        (await secret.inputValue()).length > 30
    );
    await card.getByRole("button", { name: "Скрыть", exact: true }).click();
    check("source secret can be hidden", (await secret.count()) === 0);
    page.once("dialog", dialog => dialog.accept());
    await card.getByRole("button", { name: "Отозвать", exact: true }).click();
    await card.getByText("Подключение отозвано", { exact: true }).waitFor();
    check("CRM source revocation works", true);
    await screenshot("06-audience-source-desktop");
  });
  await step("logout", async () => {
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await page
      .getByRole("heading", { name: "Вход владельца", exact: true })
      .waitFor();
    check(
      "logout clears protected interface",
      (await page
        .getByRole("link", { name: "Все кампании", exact: true })
        .count()) === 0
    );
    check(
      "logout removes local sensitive draft cache",
      await page.evaluate(() =>
        Object.keys(localStorage).every(key => !key.startsWith("tg-sender:"))
      )
    );
  });
  check(
    "no browser runtime errors",
    browserErrors.length === 0,
    browserErrors.length ? browserErrors.join("; ") : undefined
  );
  success = true;
} catch (error) {
  const safeError = String(error?.stack ?? error)
    .split(password)
    .join("[REDACTED]");
  console.error(safeError);
  // Failure screenshots are only captured after the login password field is absent.
  if ((await page.locator("#owner-password").count()) === 0)
    await screenshot("failure").catch(() => {});
  results.push({
    name: "smoke suite",
    passed: false,
    error: safeError,
    apiErrors,
  });
} finally {
  await fs.writeFile(
    path.join(runtime, "browser-smoke-results.json"),
    JSON.stringify(
      {
        success,
        testedAt: new Date().toISOString(),
        base,
        results,
        browserErrors: browserErrors.map(item =>
          item.split(password).join("[REDACTED]")
        ),
      },
      null,
      2
    )
  );
  await browser.close();
}
if (!success) process.exitCode = 1;
