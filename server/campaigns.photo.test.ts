import { describe, expect, it, vi } from "vitest";

vi.mock("./media", () => ({
  getPhotoMetadata: vi.fn(),
  requirePhotoMetadata: vi.fn(),
}));

import { validateCampaignContent } from "./campaigns";

describe("approved campaign photo content", () => {
  const photo = "424727f6-ff4a-4bf2-b713-66f5e2492cf6";

  it("allows a photo without a caption and text-only campaigns within their own limit", () => {
    expect(() => validateCampaignContent("mtproto", "", photo)).not.toThrow();
    expect(() =>
      validateCampaignContent("mtproto", "a".repeat(1024), photo)
    ).not.toThrow();
    expect(() =>
      validateCampaignContent("mtproto", "a".repeat(4096))
    ).not.toThrow();
    expect(() => validateCampaignContent("bot", "Text")).not.toThrow();
  });

  it("rejects empty text-only messages, oversized captions, and bot attachments", () => {
    expect(() => validateCampaignContent("mtproto", "   ")).toThrow();
    expect(() =>
      validateCampaignContent("mtproto", "a".repeat(1025), photo)
    ).toThrow();
    expect(() => validateCampaignContent("bot", "caption", photo)).toThrow();
    expect(() => validateCampaignContent("bot", "a".repeat(4097))).toThrow();
  });

  it("counts raw formatting in the conservative caption limit", () => {
    expect(() =>
      validateCampaignContent("mtproto", `<b>${"a".repeat(1020)}</b>`, photo)
    ).toThrow();
  });
});
