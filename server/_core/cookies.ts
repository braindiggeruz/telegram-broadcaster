import type { CookieOptions, Request } from "express";
import { appOrigin } from "../security/origin";

export function getSessionCookieOptions(
  _req: Request
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: appOrigin().startsWith("https:"),
  };
}
