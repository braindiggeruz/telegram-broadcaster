import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { prepareNewRehearsalDatabase } from "./maintenance";

const target = "tg_sender_rehearsal_0123456789abcdef01234567";

function targetClient(database = target) {
  const query = vi.fn(async () => ({ rows: [{ database }] }));
  return { client: { query } as unknown as Pick<Pool, "query">, query };
}

describe("public-schema restore preparation", () => {
  it("preserves the existing default public schema for legacy archives without a scope marker", async () => {
    const { client, query } = targetClient();
    await prepareNewRehearsalDatabase(client, target, "production", true);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects unsupported manifest scope values without touching a database", async () => {
    const { client, query } = targetClient();
    for (const scope of [null, "all", "private", false, {}]) {
      await expect(
        prepareNewRehearsalDatabase(client, target, "production", true, scope)
      ).rejects.toThrow("BACKUP_MANIFEST_INVALID");
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("removes the empty default public schema only after verifying the newly created target", async () => {
    const { client, query } = targetClient();
    await prepareNewRehearsalDatabase(
      client,
      target,
      "production",
      true,
      "public"
    );
    expect(query.mock.calls).toEqual([
      ["SELECT current_database() AS database"],
      ["DROP SCHEMA public"],
    ]);
  });

  it("rejects a target that was not created by the current rehearsal before querying it", async () => {
    const { client, query } = targetClient();
    await expect(
      prepareNewRehearsalDatabase(client, target, "production", false, "public")
    ).rejects.toThrow("RESTORE_SCHEMA_TARGET_UNSAFE");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects the source database and non-rehearsal names before querying them", async () => {
    const { client, query } = targetClient();
    await expect(
      prepareNewRehearsalDatabase(client, target, target, true, "public")
    ).rejects.toThrow("RESTORE_SCHEMA_TARGET_UNSAFE");
    await expect(
      prepareNewRehearsalDatabase(
        client,
        "production",
        "source",
        true,
        "public"
      )
    ).rejects.toThrow("RESTORE_SCHEMA_TARGET_UNSAFE");
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses schema removal when the actual connection belongs to another database", async () => {
    const { client, query } = targetClient("production");
    await expect(
      prepareNewRehearsalDatabase(client, target, "production", true, "public")
    ).rejects.toThrow("RESTORE_SCHEMA_TARGET_MISMATCH");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a nonempty schema and never escalates to CASCADE", async () => {
    const { client, query } = targetClient();
    const dependency = new Error("schema contains existing objects");
    // Model the identity check succeeding and DROP refusing dependent objects.
    query.mockResolvedValueOnce({ rows: [{ database: target }] });
    query.mockRejectedValueOnce(dependency);
    await expect(
      prepareNewRehearsalDatabase(client, target, "production", true, "public")
    ).rejects.toBe(dependency);
    expect(query.mock.calls).toEqual([
      ["SELECT current_database() AS database"],
      ["DROP SCHEMA public"],
    ]);
  });
});
