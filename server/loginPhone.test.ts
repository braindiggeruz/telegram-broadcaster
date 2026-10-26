import { describe, expect, it } from "vitest";
import { normalizeLoginPhone } from "../shared/loginPhone";

describe("Telegram login phone normalization", () => {
  it.each([
    ["+998900000000", "+998900000000"],
    [" +998 (90) 000-00-00 ", "+998900000000"],
    ["+998\u00a090\u202f000.00.00", "+998900000000"],
    ["+1 (202) 555-0123", "+12025550123"],
    ["+1234567", "+1234567"],
    ["+123456789012345", "+123456789012345"],
  ])("accepts explicit international phone %s", (input, expected) => {
    expect(normalizeLoginPhone(input)).toBe(expected);
  });

  it.each([
    "",
    "998900000000",
    "00998900000000",
    "+0998900000000",
    "+123456",
    "+1234567890123456",
    "++998900000000",
    "+998+900000000",
    "Call +998900000000",
    "+998900000000 ext 1",
    "+998900000000#1",
    "+９９８９００００００００",
    "+998/90/000/00/00",
    `+${" ".repeat(60)}1234567`,
  ])("rejects ambiguous or malformed input %s", input => {
    expect(normalizeLoginPhone(input)).toBeNull();
  });
});
