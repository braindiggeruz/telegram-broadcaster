import { useState } from "react";
import { Link, useLocation } from "wouter";
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
  ChevronRight,
  UserCircle,
  Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";

const botNavItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/bot-token", icon: Bot, label: "Bot Token" },
  { href: "/recipients", icon: Users, label: "Recipients" },
  { href: "/composer", icon: MessageSquare, label: "Message Composer" },
  { href: "/launch", icon: Rocket, label: "Broadcast Launch" },
  { href: "/history", icon: History, label: "Broadcast History" },
];

const userNavItems = [
  { href: "/user-account", icon: UserCircle, label: "User Account" },
  { href: "/user-broadcast", icon: Radio, label: "User Broadcast" },
];

function SidebarContent({ onClose }: { onClose?: () => void }) {
  const [location] = useLocation();

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-sidebar-border">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl gradient-primary glow-primary">
          <Send className="h-4 w-4 text-white" />
        </div>
        <div>
          <p className="text-sm font-semibold text-sidebar-foreground leading-tight">Telegram</p>
          <p className="text-xs text-muted-foreground leading-tight">Broadcaster</p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          Bot API
        </p>
        {botNavItems.map(({ href, icon: Icon, label }) => {
          const isActive = href === "/" ? location === "/" : location.startsWith(href);
          return (
            <Link key={href} href={href} onClick={onClose}>
              <div className={cn("nav-item group", isActive && "active")}>
                <Icon className={cn("h-4 w-4 shrink-0", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                <span className={cn("flex-1", isActive ? "text-primary" : "text-sidebar-foreground/80 group-hover:text-foreground")}>
                  {label}
                </span>
                {isActive && <ChevronRight className="h-3 w-3 text-primary/60" />}
              </div>
            </Link>
          );
        })}

        <div className="pt-4 pb-1">
          <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            User Account
          </p>
        </div>
        {userNavItems.map(({ href, icon: Icon, label }) => {
          const isActive = location.startsWith(href);
          return (
            <Link key={href} href={href} onClick={onClose}>
              <div className={cn("nav-item group", isActive && "active")}>
                <Icon className={cn("h-4 w-4 shrink-0", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                <span className={cn("flex-1", isActive ? "text-primary" : "text-sidebar-foreground/80 group-hover:text-foreground")}>
                  {label}
                </span>
                {isActive && <ChevronRight className="h-3 w-3 text-primary/60" />}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-sidebar-border px-4 py-4">
        <div className="flex items-center gap-2.5">
          <div className="h-2 w-2 rounded-full bg-emerald-400 pulse-dot" />
          <span className="text-xs text-muted-foreground">API Connected</span>
        </div>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col bg-sidebar border-r border-sidebar-border">
        <SidebarContent />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-sidebar border-r border-sidebar-border transform transition-transform duration-300 ease-out md:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <SidebarContent onClose={() => setMobileOpen(false)} />
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 md:hidden bg-card/50">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg gradient-primary">
              <Send className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-sm font-semibold">Telegram Broadcaster</span>
          </div>
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <div className="fade-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
