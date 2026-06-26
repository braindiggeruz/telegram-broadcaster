import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  User, Phone, Shield, LogOut, CheckCircle2, XCircle,
  Loader2, MessageSquare, Lock, AlertTriangle, Info,
} from "lucide-react";

type AuthStep = "idle" | "phone" | "code" | "password" | "done";

export default function UserAccount() {
  const utils = trpc.useUtils();
  const { data: session, isLoading } = trpc.mtproto.getSession.useQuery();

  const [step, setStep] = useState<AuthStep>("idle");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");

  const sendCodeMutation = trpc.mtproto.sendCode.useMutation({
    onSuccess: () => {
      toast.success("Код отправлен на ваш Telegram!");
      setStep("code");
    },
    onError: (e) => toast.error(`Ошибка: ${e.message}`),
  });

  const signInMutation = trpc.mtproto.signIn.useMutation({
    onSuccess: () => {
      toast.success("Аккаунт успешно подключён!");
      setStep("done");
      utils.mtproto.getSession.invalidate();
    },
    onError: (e) => {
      if (e.message === "TWO_FACTOR_REQUIRED") {
        toast.info("Требуется пароль двухфакторной аутентификации");
        setStep("password");
      } else {
        toast.error(`Ошибка: ${e.message}`);
      }
    },
  });

  const signInPasswordMutation = trpc.mtproto.signInPassword.useMutation({
    onSuccess: () => {
      toast.success("Аккаунт успешно подключён!");
      setStep("done");
      utils.mtproto.getSession.invalidate();
    },
    onError: (e) => toast.error(`Ошибка: ${e.message}`),
  });

  const logoutMutation = trpc.mtproto.logout.useMutation({
    onSuccess: () => {
      toast.success("Аккаунт отключён");
      setStep("idle");
      setPhone("");
      setCode("");
      setPassword("");
      utils.mtproto.getSession.invalidate();
    },
    onError: (e) => toast.error(`Ошибка: ${e.message}`),
  });

  const isConnected = session?.isActive;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">User Account</h1>
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
            Рассылка через личный аккаунт может привести к временной блокировке при агрессивном использовании.
            Рекомендуется задержка 3–5 секунд и не более 50 новых контактов в день. Используйте только для
            аудитории, которая знакома с вами.
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
              <Badge variant="outline" className="text-muted-foreground border-border">
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
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Имя</p>
                  <p className="text-sm font-medium text-foreground">
                    {[session.firstName, session.lastName].filter(Boolean).join(" ") || "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Username</p>
                  <p className="text-sm font-medium text-foreground">
                    {session.username ? `@${session.username}` : "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Телефон</p>
                  <p className="text-sm font-medium text-foreground">{session.phone || "—"}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Telegram ID</p>
                  <p className="text-sm font-mono text-foreground">{session.telegramId || "—"}</p>
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
              Введите номер телефона вашего Telegram-аккаунта. Мы отправим код подтверждения.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">

            {/* Step indicator */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <StepDot active={step === "idle" || step === "phone"} done={step !== "idle" && step !== "phone"} label="1. Телефон" />
              <div className="h-px flex-1 bg-border" />
              <StepDot active={step === "code"} done={step === "done" || step === "password"} label="2. Код" />
              <div className="h-px flex-1 bg-border" />
              <StepDot active={step === "password"} done={step === "done"} label="3. Пароль (если 2FA)" />
              <div className="h-px flex-1 bg-border" />
              <StepDot active={step === "done"} done={false} label="4. Готово" />
            </div>

            {/* Phone step */}
            {(step === "idle" || step === "phone") && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    Номер телефона
                  </label>
                  <Input
                    placeholder="+79001234567"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="bg-background/50 border-border/60 focus:border-primary/60 font-mono"
                    onKeyDown={(e) => e.key === "Enter" && phone && sendCodeMutation.mutate({ phone })}
                  />
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Info className="h-3 w-3" />
                    Введите в международном формате: +7, +1, +44 и т.д.
                  </p>
                </div>
                <Button
                  className="w-full"
                  onClick={() => sendCodeMutation.mutate({ phone })}
                  disabled={!phone || sendCodeMutation.isPending}
                >
                  {sendCodeMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Отправка кода...</>
                  ) : (
                    <><MessageSquare className="h-4 w-4 mr-2" /> Получить код в Telegram</>
                  )}
                </Button>
              </div>
            )}

            {/* Code step */}
            {step === "code" && (
              <div className="space-y-3">
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary/80">
                  Код отправлен в ваш Telegram на номер <span className="font-mono font-semibold">{phone}</span>.
                  Откройте Telegram и скопируйте 5-значный код.
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    Код подтверждения
                  </label>
                  <Input
                    placeholder="12345"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="bg-background/50 border-border/60 focus:border-primary/60 font-mono text-center text-xl tracking-[0.5em]"
                    maxLength={6}
                    onKeyDown={(e) => e.key === "Enter" && code.length >= 4 && signInMutation.mutate({ code })}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => { setStep("phone"); setCode(""); }}
                  >
                    Назад
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => signInMutation.mutate({ code })}
                    disabled={code.length < 4 || signInMutation.isPending}
                  >
                    {signInMutation.isPending ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Проверка...</>
                    ) : (
                      <><CheckCircle2 className="h-4 w-4 mr-2" /> Подтвердить</>
                    )}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={() => sendCodeMutation.mutate({ phone })}
                  disabled={sendCodeMutation.isPending}
                >
                  Отправить код повторно
                </Button>
              </div>
            )}

            {/* 2FA Password step */}
            {step === "password" && (
              <div className="space-y-3">
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-400/80">
                  На вашем аккаунте включена двухфакторная аутентификация. Введите облачный пароль Telegram.
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground flex items-center gap-2">
                    <Lock className="h-4 w-4 text-muted-foreground" />
                    Облачный пароль (2FA)
                  </label>
                  <Input
                    type="password"
                    placeholder="Ваш пароль Telegram"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="bg-background/50 border-border/60 focus:border-primary/60"
                    onKeyDown={(e) => e.key === "Enter" && password && signInPasswordMutation.mutate({ password })}
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={() => signInPasswordMutation.mutate({ password })}
                  disabled={!password || signInPasswordMutation.isPending}
                >
                  {signInPasswordMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Проверка...</>
                  ) : (
                    <><Lock className="h-4 w-4 mr-2" /> Войти</>
                  )}
                </Button>
              </div>
            )}

            {/* Done step */}
            {step === "done" && (
              <div className="text-center py-4 space-y-2">
                <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto" />
                <p className="text-foreground font-medium">Аккаунт подключён!</p>
                <p className="text-sm text-muted-foreground">Теперь вы можете запускать рассылки через ваш личный аккаунт.</p>
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
              <p className="font-medium text-foreground">Как работает MTProto рассылка?</p>
              <p>
                В отличие от Bot API, MTProto позволяет отправлять сообщения от вашего личного
                аккаунта по списку <span className="text-foreground font-medium">номеров телефонов</span>,
                @username или Telegram ID. Номера автоматически импортируются в контакты, сообщение
                отправляется, затем контакт удаляется.
              </p>
              <p className="text-amber-400/80">
                Важно: доставка по номеру возможна, только если у номера есть аккаунт Telegram и в его
                настройках приватности разрешён поиск по номеру. Часть номеров может быть недоступна —
                это ограничение Telegram, а не приложения.
              </p>
              <p>
                Сессия хранится зашифрованно в базе данных. Вам не нужно повторно входить при каждом
                использовании приложения.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`h-2 w-2 rounded-full transition-colors ${
        done ? "bg-emerald-500" : active ? "bg-primary" : "bg-border"
      }`} />
      <span className={`text-[10px] whitespace-nowrap ${active ? "text-primary" : done ? "text-emerald-400" : "text-muted-foreground"}`}>
        {label}
      </span>
    </div>
  );
}
