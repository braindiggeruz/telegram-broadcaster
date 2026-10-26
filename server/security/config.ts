import { appOrigin } from "./origin";
import { validatePasswordHash } from "./password";
import { sessionSecret } from "./sessions";
import { encryptSecret } from "./secrets";

export function assertSecurityConfiguration(): void {
  appOrigin();
  sessionSecret();
  validatePasswordHash(process.env.OWNER_PASSWORD_HASH ?? "");
  encryptSecret("configuration-check", "configuration-check");
}
