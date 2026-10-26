import "dotenv/config";
import { closePool } from "../server/connection";
import { runEncryptedBackup } from "../server/maintenance";
try {
  console.log(JSON.stringify(await runEncryptedBackup()));
} catch {
  console.error(
    "BACKUP_FAILED: inspect protected maintenance status and configuration"
  );
  process.exitCode = 1;
} finally {
  await closePool();
}
