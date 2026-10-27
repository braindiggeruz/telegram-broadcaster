import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ConnectionRecovery, {
  type ConnectionRecoveryState,
} from "../client/src/components/ConnectionRecovery";

function renderRecovery(state: ConnectionRecoveryState, isFetching = false) {
  return renderToStaticMarkup(
    createElement(ConnectionRecovery, {
      state,
      isFetching,
      onRetry: () => undefined,
    })
  );
}

describe("session connection recovery view", () => {
  it("announces the connection state politely and offers an explicit retry", () => {
    const html = renderRecovery("offline");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-labelledby="connection-recovery-title"');
    expect(html).toContain("Нет соединения");
    expect(html).toContain("Проверка возобновится автоматически");
    expect(html).toContain("Повторить сейчас");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).not.toContain("Вход владельца");
    expect(html).not.toContain('type="password"');
  });

  it("prevents repeated retries while a check is running", () => {
    const html = renderRecovery("reconnecting", true);
    expect(html).toContain("Восстанавливаем соединение");
    expect(html).toContain("Повторяем проверку доступа автоматически");
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });

  it("keeps terminal failures generic without promising automatic recovery", () => {
    const html = renderRecovery("unavailable");
    expect(html).toContain("Проверка доступа недоступна");
    expect(html).toContain("обратитесь к администратору сервиса");
    expect(html).not.toContain("автоматически");
    expect(html).not.toContain("TRPCClientError");
    expect(html).not.toContain("UNAUTHORIZED");
  });

  it("uses a checking state before access is known", () => {
    const html = renderRecovery("checking", true);
    expect(html).toContain("Проверяем доступ");
    expect(html).not.toContain("Нет соединения");
    expect(html).not.toContain("Вход владельца");
  });
});
