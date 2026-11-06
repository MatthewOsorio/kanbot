"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Light/dark switch (§13). layout.tsx applies the saved choice before paint; this flips and saves it. */
export function ThemeToggle() {
  function toggle() {
    const dark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      // storage blocked: the switch still works for this page
    }
  }
  // The icon follows the class through dark: variants, so no React state to sync.
  return (
    <Button size="icon-sm" variant="ghost" aria-label="Toggle dark theme" onClick={toggle}>
      <Moon aria-hidden className="dark:hidden" />
      <Sun aria-hidden className="hidden dark:block" />
    </Button>
  );
}
