import { describe, expect, it } from "vitest";
import {
  DeliveryError,
  normalizeRecipient,
  safeCode,
  senderKey,
} from "./types";

describe("delivery identity and error boundary", () => {
  it("deduplicates aliases without changing numeric chat IDs into phone numbers", () => {
    expect(normalizeRecipient("-1001234567890")).toBe("chat:-1001234567890");
    expect(normalizeRecipient("123456789012")).toBe("chat:123456789012");
    expect(normalizeRecipient("+998901234567")).toBe("phone:+998901234567");
    expect(normalizeRecipient("phone:+998901234567")).toBe(
      "phone:+998901234567"
    );
    expect(normalizeRecipient("@Some_User")).toBe("username:some_user");
    expect(normalizeRecipient("username:SOME_USER")).toBe("username:some_user");
  });
  it("rejects arbitrary spreadsheet cells, malformed recipients and invalid owners", () => {
    for (const input of [
      "order 123456789012",
      "0",
      "+00123456789",
      "https://t.me/a",
      "chat:abc",
      "phone:123456789",
    ])
      expect(() => normalizeRecipient(input)).toThrow();
    expect(() => senderKey(0, "bot")).toThrow();
    expect(() => senderKey(1.5, "bot")).toThrow();
    expect(senderKey(23, "mtproto")).toBe("23:mtproto");
  });
  it("never retains raw exception text or credentials as error codes", () => {
    expect(safeCode("FLOOD_WAIT_50")).toBe("FLOOD_WAIT_50");
    expect(safeCode("https://api.telegram.org/botSECRET/sendMessage")).toBe(
      "TRANSPORT_ERROR"
    );
    expect(safeCode("connection failed password=secret")).toBe(
      "TRANSPORT_ERROR"
    );
    const error = new DeliveryError("recipient", "INPUT_USER_DEACTIVATED");
    expect(error.category).toBe("recipient");
  });
});
