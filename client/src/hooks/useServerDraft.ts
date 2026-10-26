import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

export type ParseMode = "HTML" | "Markdown" | "MarkdownV2" | "None";
type DraftValue = { message: string; parseMode: ParseMode; version: number };

export function useServerDraft(key: "bot" | "mtproto") {
  const storageKey = `tg-sender:draft:${key}`;
  const query = trpc.draft.get.useQuery(
    { key },
    { refetchOnWindowFocus: false }
  );
  const mutation = trpc.draft.save.useMutation();
  const [draft, setDraft] = useState<DraftValue>({
    message: "",
    parseMode: "HTML",
    version: 0,
  });
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [conflicted, setConflicted] = useState(false);
  const current = useRef(draft);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    if (readyRef.current || query.isLoading || query.isError) return;
    const server: DraftValue = {
      message: query.data?.message ?? "",
      parseMode: query.data?.parseMode ?? "HTML",
      version: query.data?.version ?? 0,
    };
    let value = server;
    try {
      const cached = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (
        cached &&
        typeof cached.message === "string" &&
        ["HTML", "Markdown", "MarkdownV2", "None"].includes(cached.parseMode)
      ) {
        value = {
          message: cached.message,
          parseMode: cached.parseMode,
          version: server.version,
        };
        if (
          value.message !== server.message ||
          value.parseMode !== server.parseMode
        ) {
          revision.current = 1;
          setDirty(true);
          if (cached.version !== server.version) {
            setConflicted(true);
            setError(
              "На сервере есть другая версия. Ваш текст сохранён в этом браузере. Скопируйте его перед загрузкой серверной версии."
            );
          }
        } else localStorage.removeItem(storageKey);
      }
    } catch {
      /* Storage optional. */
    }
    current.current = value;
    setDraft(value);
    readyRef.current = true;
    setReady(true);
  }, [query.data, query.isLoading, query.isError, storageKey]);

  const change = useCallback(
    (patch: Partial<Pick<DraftValue, "message" | "parseMode">>) => {
      current.current = { ...current.current, ...patch };
      revision.current++;
      setDraft(current.current);
      setDirty(true);
      try {
        localStorage.setItem(storageKey, JSON.stringify(current.current));
      } catch {
        /* Server persists draft. */
      }
    },
    [storageKey]
  );

  const saveNow = useCallback(async () => {
    if (!readyRef.current) throw new Error("Черновик ещё загружается");
    if (error) throw new Error(error);
    // All callers wait for the same flight and recheck before claiming the next save.
    while (inFlight.current) await inFlight.current;
    while (savedRevision.current < revision.current) {
      if (inFlight.current) {
        await inFlight.current;
        continue;
      }
      const saveRevision = revision.current;
      const snapshot = { ...current.current };
      const task = (async () => {
        const saved = await mutation.mutateAsync({
          key,
          message: snapshot.message,
          parseMode: snapshot.parseMode,
          expectedVersion: snapshot.version,
        });
        current.current = { ...current.current, version: saved.version };
        savedRevision.current = saveRevision;
        setDraft(current.current);
        const stillDirty = revision.current !== saveRevision;
        setDirty(stillDirty);
        try {
          if (stillDirty)
            localStorage.setItem(storageKey, JSON.stringify(current.current));
          else localStorage.removeItem(storageKey);
        } catch {
          /* Storage optional. */
        }
      })();
      inFlight.current = task;
      try {
        await task;
      } catch (cause) {
        if (
          cause &&
          typeof cause === "object" &&
          "data" in cause &&
          (cause.data as { code?: string })?.code === "CONFLICT"
        )
          setConflicted(true);
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось сохранить черновик"
        );
        throw cause;
      } finally {
        if (inFlight.current === task) inFlight.current = null;
      }
    }
    return current.current;
  }, [key, error, mutation.mutateAsync, storageKey]);

  useEffect(() => {
    if (!ready || !dirty || error) return;
    const timer = setTimeout(() => {
      void saveNow().catch(() => {});
    }, 700);
    return () => clearTimeout(timer);
  }, [draft.message, draft.parseMode, ready, dirty, error, saveNow]);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);

  const reloadServer = async () => {
    if (inFlight.current) {
      try {
        await inFlight.current;
      } catch {
        /* User chose recovery. */
      }
    }
    const result = await query.refetch();
    if (result.error) {
      setError(result.error.message);
      return;
    }
    const value: DraftValue = {
      message: result.data?.message ?? "",
      parseMode: result.data?.parseMode ?? "HTML",
      version: result.data?.version ?? 0,
    };
    current.current = value;
    setDraft(value);
    revision.current = 0;
    savedRevision.current = 0;
    setDirty(false);
    setError("");
    setConflicted(false);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* Optional. */
    }
  };
  return {
    ...draft,
    ready,
    dirty,
    conflicted,
    saving: mutation.isPending,
    error: error || query.error?.message || "",
    setMessage: (message: string) => change({ message }),
    setParseMode: (parseMode: ParseMode) => change({ parseMode }),
    saveNow,
    reloadServer,
    retry: () => {
      if (!conflicted) {
        setError("");
        if (query.error) void query.refetch();
      }
    },
  };
}
