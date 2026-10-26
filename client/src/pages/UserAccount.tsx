import { useEffect, useMemo, useRef, useState } from "react";
import { LOGIN_PHONE_ERROR, normalizeLoginPhone } from "@shared/loginPhone";
import type { LoginCodeDelivery } from "@shared/authStatus";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  User,
  Phone,
  Shield,
  LogOut,
  CheckCircle2,
  XCircle,
  Loader2,
  MessageSquare,
  Lock,
  AlertTriangle,
  Info,
} from "lucide-react";

type AuthStep = "idle" | "phone" | "code" | "password" | "done";

function waitLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} мин ${seconds % 60} с` : `${seconds} с`;
}

function deliveryMessage(delivery: LoginCodeDelivery) {
  switch (delivery) {
    case "telegram":
      return "Код запрошен в Telegram. Проверьте служебный чат Telegram на ваших устройствах.";
    case "sms":
      return "Код запрошен по SMS. Проверьте сообщения на телефоне.";
    case "call":
      return "Telegram выбрал телефонный звонок для получения кода.";
    case "email":
      return "Telegram выбрал доставку кода по электронной почте. Проверьте почту, указанную в Telegram.";
    default:
      return "Telegram принял запрос кода. Способ доставки определяет Telegram.";
  }
}

function codeRequestErrorMessage(message: string) {
  try {
    const issues: unknown = JSON.parse(message);
    if (
      Array.isArray(issues) &&
      issues.length > 0 &&
      issues.every(
        issue =>
          issue &&
          typeof issue === "object" &&
          "path" in issue &&
          Array.isArray(issue.path) &&
          issue.path[0] === "phone"
      )
    ) {
      return LOGIN_PHONE_ERROR;
    }
  } catch {
    // Telegram errors are ordinary messages and should remain visible.
  }
  return message || "Не удалось запросить код. Попробуйте ещё раз.";
}

export default function UserAccount() {
  const utils = trpc.useUtils();
  const { data: session, isLoading } = trpc.mtproto.getSession.useQuery();
  const authStatus = trpc.mtproto.getAuthStatus.useQuery(undefined, {
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const [step, setStep] = useState<AuthStep>("idle");
  const [editingPhone, setEditingPhone] = useState(false);
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const codeRequestPending = useRef(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [clockTick, setClockTick] = useState(() => performance.now());
  const status = authStatus.data;
  const clock = useMemo(
    () =>
      status
        ? {
            serverAt: Date.parse(status.serverNow),
            observedAt: performance.now(),
          }
        : null,
    [status, authStatus.dataUpdatedAt]
  );
  useEffect(() => {
    const timer = window.setInterval(
      () => setClockTick(performance.now()),
      1000
    );
    return () => window.clearInterval(timer);
  }, []);
  const serverNow = clock
    ? clock.serverAt + Math.max(0, clockTick - clock.observedAt)
    : 0;
  const statusUnavailable =
    !status || !!authStatus.error || !Number.isFinite(serverNow);
  const retrySeconds =
    status?.retryAt && !statusUnavailable
      ? Math.max(0, Math.ceil((Date.parse(status.retryAt) - serverNow) / 1000))
      : 0;
  const pendingExpired =
    !!status?.pending && Date.parse(status.pending.expiresAt) <= serverNow;
  const pending = pendingExpired ? null : status?.pending;
  const codeSeconds = pending
    ? Math.max(0, Math.ceil((Date.parse(pending.expiresAt) - serverNow) / 1000))
    : 0;
  const requestBlocked =
    statusUnavailable || retrySeconds > 0 || !status?.attemptsRemaining;
  const expectedCodeLength = pending?.codeLength;
  const codeValid = expectedCodeLength
    ? code.length === expectedCodeLength
    : code.length >= 4 && code.length <= 8;

  useEffect(() => {
    if (session?.isActive || editingPhone || !status) return;
    if (pending) {
      setStep(current => (current === "done" ? current : pending.step));
    } else {
      setStep(current =>
        current === "code" || current === "password" ? "phone" : current
      );
      if (pendingExpired) {
        setCode("");
        setPassword("");
        setAuthNotice("Время для входа истекло. Запросите новый код.");
      }
    }
  }, [status, pendingExpired, editingPhone, session?.isActive]);

  const sendCodeMutation = trpc.mtproto.sendCode.useMutation({
    onSuccess: result => {
      utils.mtproto.getAuthStatus.setData(undefined, result.status);
      setEditingPhone(false);
      setAuthNotice(null);
      if (result.status.pending) setStep(result.status.pending.step);
      if (result.resumed) {
        toast.info("Продолжите начатый вход — новый код не запрашивался.");
      } else if (result.sent) {
        toast.success(
          deliveryMessage(result.status.pending?.delivery ?? "unknown")
        );
      }
    },
    onError: e => {
      const message = codeRequestErrorMessage(e.message);
      setAuthNotice(message);
      toast.error(message);
      void authStatus.refetch();
    },
    onSettled: () => {
      codeRequestPending.current = false;
    },
  });

  const requestCode = (resend = false) => {
    if (
      codeRequestPending.current ||
      sendCodeMutation.isPending ||
      requestBlocked
    )
      return;
    const normalized = normalizeLoginPhone(phone);
    if (!normalized) {
      setPhoneError(LOGIN_PHONE_ERROR);
      return;
    }
    setPhoneError(null);
    setPhone(normalized);
    setAuthNotice(null);
    codeRequestPending.current = true;
    sendCodeMutation.mutate({ phone: normalized, resend });
  };

  const changePhone = () => {
    setEditingPhone(true);
    setStep("phone");
    setCode("");
    setPassword("");
    setAuthNotice(null);
  };

  const signInMutation = trpc.mtproto.signIn.useMutation({
    onSuccess: () => {
      toast.success("Аккаунт успешно подключён!");
      setStep("done");
      setCode("");
      setPassword("");
      setPhone("");
      void utils.mtproto.getSession.invalidate();
      void utils.mtproto.getAuthStatus.invalidate();
    },
    onError: e => {
      if (e.message === "TWO_FACTOR_REQUIRED") {
        toast.info("Требуется пароль двухфакторной аутентификации");
        setCode("");
        setStep("password");
      } else {
        toast.error(`Ошибка: ${e.message}`);
      }
      void authStatus.refetch();
    },
  });

  const signInPasswordMutation = trpc.mtproto.signInPassword.useMutation({
    onSuccess: () => {
      toast.success("Аккаунт успешно подключён!");
      setStep("done");
      setCode("");
      setPassword("");
      setPhone("");
      void utils.mtproto.getSession.invalidate();
      void utils.mtproto.getAuthStatus.invalidate();
    },
    onError: e => {
      toast.error(`Ошибка: ${e.message}`);
      void authStatus.refetch();
    },
  });

  const logoutMutation = trpc.mtproto.logout.useMutation({
    onSuccess: () => {
      toast.success("Аккаунт отключён");
      setStep("idle");
      setEditingPhone(false);
      setPhone("");
      setPhoneError(null);
      setCode("");
      setPassword("");
      setAuthNotice(null);
      void utils.mtproto.getSession.invalidate();
      void utils.mtproto.getAuthStatus.invalidate();
    },
    onError: e => toast.error(`Ошибка: ${e.message}`),
  });

  const isConnected = session?.isActive;

  return (
    <div className="p-5 lg:p-8 max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Личный аккаунт</h1>
        <p className="text-muted-foreground mt-1">
          Подключите личный Telegram-аккаунт для рассылки через MTProto
        </p>
      </div>

      {/* Warning banner */}
      <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
        <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="text-sm text-amber-300 space-y-1">
          <p className="font-semibold">Важные ограничения Telegram</p>
          <p className="text-amber-400/80">
            Отправляйте сообщения только ожидающей их аудитории. Диспетчер
            соблюдает паузы Telegram, но задержка не гарантирует отсутствие
            ограничений. Используйте для аудитории, которая знакома с вами.
          </p>
        </div>
      </div>

      {/* Session Status Card */}
      <Card className="border-border/50 bg-card/50 backdrop-blur">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4 text-primary" />
              Статус подключения
            </CardTitle>
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : isConnected ? (
              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Подключён
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="text-muted-foreground border-border"
              >
                <XCircle className="h-3 w-3 mr-1" /> Не подключён
              </Badge>
            )}
          </div>
        </CardHeader>

        {isConnected && session && (
          <>
            <Separator className="bg-border/50" />
            <CardContent className="pt-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Имя
                  </p>
                  <p className="text-sm font-medium text-foreground">
                    {[session.firstName, session.lastName]
                      .filter(Boolean)
                      .join(" ") || "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Username
                  </p>
                  <p className="text-sm font-medium text-foreground">
                    {session.username ? `@${session.username}` : "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Телефон
                  </p>
                  <p className="text-sm font-medium text-foreground">
                    {session.phone || "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Telegram ID
                  </p>
                  <p className="text-sm font-mono text-foreground">
                    {session.telegramId || "—"}
                  </p>
                </div>
              </div>

              <Separator className="bg-border/50" />

              <Button
                variant="outline"
                size="sm"
                className="text-red-400 border-red-500/30 hover:bg-red-500/10 hover:text-red-300"
                onClick={() => logoutMutation.mutate()}
                disabled={logoutMutation.isPending}
              >
                {logoutMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <LogOut className="h-4 w-4 mr-2" />
                )}
                Отключить аккаунт
              </Button>
            </CardContent>
          </>
        )}
      </Card>

      {/* Auth Flow */}
      {!isConnected && !isLoading && (
        <Card className="border-border/50 bg-card/50 backdrop-blur">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              Подключить аккаунт
            </CardTitle>
            <CardDescription>
              Введите номер телефона вашего Telegram-аккаунта. Способ доставки
              кода определяет Telegram.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {authStatus.error ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 p-3 space-y-2 text-sm"
              >
                <p>
                  Не удалось проверить состояние входа. Запрос кода временно
                  недоступен.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={authStatus.isFetching}
                  onClick={() => void authStatus.refetch()}
                >
                  Повторить проверку
                </Button>
              </div>
            ) : statusUnavailable ? (
              <p role="status" className="text-sm text-muted-foreground">
                Проверяем состояние входа…
              </p>
            ) : (
              <div
                id="telegram-auth-status"
                role="status"
                aria-live="polite"
                className="rounded-lg border border-border p-3 text-sm text-muted-foreground"
              >
                {retrySeconds > 0 ? (
                  <p>
                    {status.attemptsRemaining === 0
                      ? "Лимит запросов кода исчерпан. "
                      : ""}
                    Следующий запрос кода через {waitLabel(retrySeconds)}.{" "}
                    Ничего не отправится автоматически.
                  </p>
                ) : status.attemptsRemaining > 0 ? (
                  <p>
                    Можно запросить код. Осталось запросов:{" "}
                    {status.attemptsRemaining}.
                  </p>
                ) : (
                  <p>
                    Сейчас запрос кода недоступен. Обновляем состояние входа.
                  </p>
                )}
              </div>
            )}
            {authNotice && (
              <p role="alert" className="text-sm text-amber-400">
                {authNotice}
              </p>
            )}
            {/* Step indicator */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <StepDot
                active={step === "idle" || step === "phone"}
                done={step !== "idle" && step !== "phone"}
                label="1. Телефон"
              />
              <div className="h-px flex-1 bg-border" />
              <StepDot
                active={step === "code"}
                done={step === "done" || step === "password"}
                label="2. Код"
              />
              <div className="h-px flex-1 bg-border" />
              <StepDot
                active={step === "password"}
                done={step === "done"}
                label="3. Пароль (если 2FA)"
              />
              <div className="h-px flex-1 bg-border" />
              <StepDot
                active={step === "done"}
                done={false}
                label="4. Готово"
              />
            </div>

            {/* Phone step */}
            {(step === "idle" || step === "phone") && (
              <form
                className="space-y-3"
                noValidate
                onSubmit={e => {
                  e.preventDefault();
                  requestCode();
                }}
              >
                <div className="space-y-2">
                  <label
                    htmlFor="telegram-login-phone"
                    className="text-sm font-medium text-foreground flex items-center gap-2"
                  >
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    Номер телефона
                  </label>
                  <Input
                    id="telegram-login-phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    maxLength={64}
                    placeholder="+998 90 123 45 67"
                    value={phone}
                    onChange={e => {
                      setPhone(e.target.value);
                      setPhoneError(null);
                    }}
                    onBlur={() =>
                      setPhoneError(
                        normalizeLoginPhone(phone) ? null : LOGIN_PHONE_ERROR
                      )
                    }
                    disabled={sendCodeMutation.isPending}
                    aria-invalid={!!phoneError}
                    aria-describedby={
                      phoneError
                        ? "telegram-login-phone-help telegram-login-phone-error"
                        : "telegram-login-phone-help"
                    }
                    className="bg-background/50 border-border/60 focus:border-primary/60 font-mono"
                  />
                  <p
                    id="telegram-login-phone-help"
                    className="text-xs text-muted-foreground flex items-center gap-1"
                  >
                    <Info className="h-3 w-3" />
                    Укажите + и код страны. Пробелы, скобки и дефисы можно
                    оставить.
                  </p>
                  {phoneError && (
                    <p
                      id="telegram-login-phone-error"
                      role="alert"
                      className="text-xs text-destructive"
                    >
                      {phoneError}
                    </p>
                  )}
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={sendCodeMutation.isPending || requestBlocked}
                  aria-describedby="telegram-auth-status"
                >
                  {sendCodeMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Отправка
                      кода...
                    </>
                  ) : (
                    <>
                      <MessageSquare className="h-4 w-4 mr-2" />
                      {retrySeconds > 0
                        ? `Подождите ${waitLabel(retrySeconds)}`
                        : "Получить код"}
                    </>
                  )}
                </Button>
              </form>
            )}

            {/* Code step */}
            {step === "code" && (
              <div className="space-y-3">
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary/80">
                  <p>{deliveryMessage(pending?.delivery ?? "unknown")}</p>
                  {pending && (
                    <p className="mt-2">
                      Номер:{" "}
                      <span className="font-mono font-semibold">
                        {pending.maskedPhone}
                      </span>
                      . На ввод кода осталось {waitLabel(codeSeconds)}. Попыток
                      ввода: {pending.codeAttemptsRemaining}.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="telegram-login-code"
                    className="text-sm font-medium text-foreground flex items-center gap-2"
                  >
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    Код подтверждения
                  </label>
                  <Input
                    id="telegram-login-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder={"12345678".slice(0, expectedCodeLength ?? 5)}
                    value={code}
                    onChange={e =>
                      setCode(
                        e.target.value
                          .replace(/\D/g, "")
                          .slice(0, expectedCodeLength ?? 8)
                      )
                    }
                    className="bg-background/50 border-border/60 focus:border-primary/60 font-mono text-center text-xl tracking-[0.5em]"
                    maxLength={expectedCodeLength ?? 8}
                    disabled={
                      statusUnavailable ||
                      !pending?.codeAttemptsRemaining ||
                      signInMutation.isPending ||
                      sendCodeMutation.isPending
                    }
                    onKeyDown={e =>
                      e.key === "Enter" &&
                      codeValid &&
                      !statusUnavailable &&
                      !!pending?.codeAttemptsRemaining &&
                      !signInMutation.isPending &&
                      !sendCodeMutation.isPending &&
                      signInMutation.mutate({ code })
                    }
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    disabled={
                      sendCodeMutation.isPending || signInMutation.isPending
                    }
                    onClick={changePhone}
                  >
                    Изменить номер
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => signInMutation.mutate({ code })}
                    disabled={
                      !codeValid ||
                      statusUnavailable ||
                      !pending?.codeAttemptsRemaining ||
                      signInMutation.isPending ||
                      sendCodeMutation.isPending
                    }
                  >
                    {signInMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />{" "}
                        Проверка...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-4 w-4 mr-2" /> Подтвердить
                      </>
                    )}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={() => requestCode(true)}
                  disabled={
                    sendCodeMutation.isPending ||
                    signInMutation.isPending ||
                    requestBlocked ||
                    !normalizeLoginPhone(phone)
                  }
                >
                  {retrySeconds > 0
                    ? `Повторный запрос через ${waitLabel(retrySeconds)}`
                    : "Запросить код повторно"}
                </Button>
                {!normalizeLoginPhone(phone) && (
                  <p className="text-xs text-muted-foreground">
                    Вход восстановлен после перезагрузки. Введите полученный
                    код. Для нового запроса нажмите «Изменить номер» и укажите
                    его снова.
                  </p>
                )}
              </div>
            )}

            {/* 2FA Password step */}
            {step === "password" && (
              <div className="space-y-3">
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-400/80">
                  На вашем аккаунте включена двухфакторная аутентификация.
                  Введите облачный пароль Telegram.
                  {pending && (
                    <p className="mt-2">
                      Номер: {pending.maskedPhone}. На вход осталось{" "}
                      {waitLabel(codeSeconds)}.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="telegram-login-password"
                    className="text-sm font-medium text-foreground flex items-center gap-2"
                  >
                    <Lock className="h-4 w-4 text-muted-foreground" />
                    Облачный пароль (2FA)
                  </label>
                  <Input
                    id="telegram-login-password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="Ваш пароль Telegram"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="bg-background/50 border-border/60 focus:border-primary/60"
                    disabled={
                      statusUnavailable ||
                      !pending ||
                      signInPasswordMutation.isPending
                    }
                    onKeyDown={e =>
                      e.key === "Enter" &&
                      password &&
                      !statusUnavailable &&
                      !!pending &&
                      !signInPasswordMutation.isPending &&
                      signInPasswordMutation.mutate({ password })
                    }
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={() => signInPasswordMutation.mutate({ password })}
                  disabled={
                    !password ||
                    statusUnavailable ||
                    !pending ||
                    signInPasswordMutation.isPending
                  }
                >
                  {signInPasswordMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />{" "}
                      Проверка...
                    </>
                  ) : (
                    <>
                      <Lock className="h-4 w-4 mr-2" /> Войти
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={changePhone}
                  disabled={signInPasswordMutation.isPending}
                >
                  Изменить номер
                </Button>
              </div>
            )}

            {/* Done step */}
            {step === "done" && (
              <div className="text-center py-4 space-y-2">
                <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto" />
                <p className="text-foreground font-medium">
                  Аккаунт подключён!
                </p>
                <p className="text-sm text-muted-foreground">
                  Теперь вы можете запускать рассылки через ваш личный аккаунт.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Info card */}
      <Card className="border-border/50 bg-card/30">
        <CardContent className="pt-4">
          <div className="flex gap-3">
            <Info className="h-5 w-5 text-blue-400 shrink-0 mt-0.5" />
            <div className="text-sm text-muted-foreground space-y-2">
              <p className="font-medium text-foreground">
                Как работает MTProto рассылка?
              </p>
              <p>
                В отличие от Bot API, MTProto позволяет отправлять сообщения от
                вашего личного аккаунта по списку{" "}
                <span className="text-foreground font-medium">
                  номеров телефонов
                </span>
                , @username или Telegram ID. Номера автоматически импортируются
                в контакты, сообщение отправляется, затем контакт удаляется.
              </p>
              <p className="text-amber-400/80">
                Важно: доставка по номеру возможна, только если у номера есть
                аккаунт Telegram и в его настройках приватности разрешён поиск
                по номеру. Часть номеров может быть недоступна — это ограничение
                Telegram, а не приложения.
              </p>
              <p>
                Сессия хранится зашифрованно в базе данных. Вам не нужно
                повторно входить при каждом использовании приложения.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StepDot({
  active,
  done,
  label,
}: {
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={`h-2 w-2 rounded-full transition-colors ${
          done ? "bg-emerald-500" : active ? "bg-primary" : "bg-border"
        }`}
      />
      <span
        className={`text-[10px] whitespace-nowrap ${active ? "text-primary" : done ? "text-emerald-400" : "text-muted-foreground"}`}
      >
        {label}
      </span>
    </div>
  );
}
