import "dotenv/config";
import { closePool } from "../server/connection";
import { rehearseLatestBackup } from "../server/maintenance";
try {
  console.log(
    JSON.stringify(await rehearseLatestBackup({ backupFile: process.argv[2] }))
  );
} catch {
  console.error(
    "RESTORE_REHEARSAL_FAILED: inspect protected maintenance status and configuration"
  );
  process.exitCode = 1;
} finally {
  await closePool();
}
