import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Bot,
  Users,
  MessageSquare,
  Rocket,
  History,
  Menu,
  X,
  Send,
  UserCircle,
  Radio,
  Zap,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
const items = [
  { href: "/", icon: LayoutDashboard, label: "Обзор" },
  { href: "/autopilot", icon: Zap, label: "Автопилот" },
  { href: "/recipients", icon: Users, label: "Аудитория" },
  { href: "/composer", icon: MessageSquare, label: "Сообщение" },
  { href: "/launch", icon: Rocket, label: "Рассылка через бота" },
  { href: "/user-broadcast", icon: Radio, label: "Рассылка от аккаунта" },
  { href: "/history", icon: History, label: "Все кампании" },
];
function SidebarContent({ onClose }: { onClose?: () => void }) {
  const [location] = useLocation();
  const client = useQueryClient();
  const logout = trpc.auth.logout.useMutation({
    onSuccess: () => {
      try {
        Object.keys(localStorage)
          .filter(key => key.startsWith("tg-sender:"))
          .forEach(key => localStorage.removeItem(key));
      } catch {}
      client.clear();
      window.location.assign("/");
    },
    onError: error => toast.error(error.message),
  });
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-5 py-6 border-b border-sidebar-border">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl gradient-primary">
          <Send className="h-5 w-5 text-white" />
        </div>
        <div>
          <p className="text-sm font-semibold">
            TG Sender <span className="text-primary">2.0</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            Рассылки под контролем
          </p>
        </div>
        {onClose && (
          <button
            aria-label="Закрыть меню"
            onClick={onClose}
            className="ml-auto rounded-md p-2 hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {items.map(({ href, icon: Icon, label }) => (
          <Link
            key={href}
            href={href}
            onClick={onClose}
            className={cn(
              "nav-item",
              (href === "/" ? location === "/" : location.startsWith(href)) &&
                "active"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{label}</span>
          </Link>
        ))}
        <p className="pt-6 pb-2 px-3 text-[10px] uppercase tracking-widest text-muted-foreground">
          Подключения
        </p>
        {[
          { href: "/bot-token", icon: Bot, label: "Telegram-бот" },
          { href: "/user-account", icon: UserCircle, label: "Личный аккаунт" },
        ].map(({ href, icon: Icon, label }) => (
          <Link
            key={href}
            href={href}
            onClick={onClose}
            className={cn("nav-item", location === href && "active")}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="border-t border-sidebar-border p-4">
        <Button
          variant="ghost"
          className="w-full justify-start text-muted-foreground"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          <LogOut className="h-4 w-4" />
          Выйти
        </Button>
      </div>
    </div>
  );
}
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-dvh bg-background overflow-hidden">
      <aside className="hidden md:flex w-60 shrink-0 flex-col bg-sidebar border-r border-sidebar-border">
        <SidebarContent />
      </aside>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
            onClick={() => setOpen(false)}
          />
          <aside className="fixed inset-y-0 left-0 z-50 w-64 bg-sidebar border-r border-sidebar-border md:hidden">
            <SidebarContent onClose={() => setOpen(false)} />
          </aside>
        </>
      )}
      <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 md:hidden bg-card/50">
          <button
            aria-label="Открыть меню"
            onClick={() => setOpen(true)}
            className="rounded-md p-2 hover:bg-muted"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Send className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">TG Sender 2.0</span>
        </div>
        <main className="flex-1 overflow-y-auto">
          <div className="fade-in">{children}</div>
        </main>
      </div>
    </div>
  );
}
