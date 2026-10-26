import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  PHOTO_CAPTION_MAX_LENGTH,
  PHOTO_MAX_BYTES,
  type PhotoAttachment,
} from "@shared/media";

export type ParseMode = "HTML" | "Markdown" | "MarkdownV2" | "None";
type DraftValue = {
  message: string;
  parseMode: ParseMode;
  version: number;
  photoId: string | null;
  photo: PhotoAttachment | null;
};

function recoverPhoto(value: unknown): PhotoAttachment | null {
  if (!value || typeof value !== "object") return null;
  const photo = value as PhotoAttachment;
  if (
    typeof photo.id !== "string" ||
    !/^[a-f\d-]{36}$/i.test(photo.id) ||
    photo.url !== `/api/media/${photo.id}` ||
    typeof photo.name !== "string" ||
    photo.name.length > 200 ||
    !["image/jpeg", "image/png"].includes(photo.mimeType) ||
    !Number.isSafeInteger(photo.size) ||
    photo.size <= 0 ||
    photo.size > PHOTO_MAX_BYTES ||
    !Number.isSafeInteger(photo.width) ||
    photo.width <= 0 ||
    !Number.isSafeInteger(photo.height) ||
    photo.height <= 0 ||
    typeof photo.sha256 !== "string" ||
    !/^[a-f\d]{64}$/i.test(photo.sha256)
  )
    return null;
  return {
    id: photo.id,
    name: photo.name,
    url: photo.url,
    mimeType: photo.mimeType,
    size: photo.size,
    width: photo.width,
    height: photo.height,
    sha256: photo.sha256,
  };
}

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
    photoId: null,
    photo: null,
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
      photoId: key === "mtproto" ? (query.data?.photoId ?? null) : null,
      photo: key === "mtproto" ? (query.data?.photo ?? null) : null,
    };
    let value = server;
    try {
      const cached = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (
        cached &&
        typeof cached.message === "string" &&
        ["HTML", "Markdown", "MarkdownV2", "None"].includes(cached.parseMode)
      ) {
        const cachedPhoto = recoverPhoto(cached.photo);
        const photoId =
          key === "mtproto" && Object.hasOwn(cached, "photoId")
            ? cached.photoId === null
              ? null
              : (cachedPhoto?.id ?? server.photoId)
            : server.photoId;
        value = {
          message: cached.message,
          parseMode: cached.parseMode,
          version: server.version,
          photoId,
          photo:
            photoId === cachedPhoto?.id
              ? cachedPhoto
              : photoId === server.photoId
                ? server.photo
                : null,
        };
        if (
          value.message !== server.message ||
          value.parseMode !== server.parseMode ||
          value.photoId !== server.photoId
        ) {
          revision.current = 1;
          setDirty(true);
          if (cached.version !== server.version) {
            setConflicted(true);
            setError(
              "На сервере есть другая версия. Ваш черновик сохранён в этом браузере. Скопируйте текст перед загрузкой серверной версии."
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
  }, [query.data, query.isLoading, query.isError, storageKey, key]);

  const change = useCallback(
    (
      patch: Partial<
        Pick<DraftValue, "message" | "parseMode" | "photoId" | "photo">
      >
    ) => {
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
    if (
      current.current.message.length >
      (current.current.photoId ? PHOTO_CAPTION_MAX_LENGTH : 4096)
    )
      throw new Error(
        current.current.photoId
          ? "Сократите подпись до 1 024 символов."
          : "Сократите сообщение до 4 096 символов."
      );
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
          ...(key === "mtproto" ? { photoId: snapshot.photoId } : {}),
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
    if (
      draft.message.length > (draft.photoId ? PHOTO_CAPTION_MAX_LENGTH : 4096)
    )
      return;
    const timer = setTimeout(() => {
      void saveNow().catch(() => {});
    }, 700);
    return () => clearTimeout(timer);
  }, [
    draft.message,
    draft.parseMode,
    draft.photoId,
    ready,
    dirty,
    error,
    saveNow,
  ]);

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
      photoId: key === "mtproto" ? (result.data?.photoId ?? null) : null,
      photo: key === "mtproto" ? (result.data?.photo ?? null) : null,
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
    setPhoto: (photo: PhotoAttachment | null) =>
      change({ photoId: photo?.id ?? null, photo }),
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
