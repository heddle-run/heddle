"use client";

import { useState, useEffect } from "react";
import { Github } from "lucide-react";
import { motion } from "framer-motion";
import { GITHUB_URL } from "@/lib/constants";

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [pastHero, setPastHero] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 20);
      setPastHero(window.scrollY > window.innerHeight * 0.7);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.nav
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className={`fixed top-0 right-0 left-0 z-50 transition-colors duration-300 ${
        scrolled
          ? pastHero
            ? "bg-bg/80 backdrop-blur-md"
            : "bg-white/80 backdrop-blur-md"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <span
            className={`text-xl font-semibold tracking-tight transition-colors duration-300 ${
              pastHero ? "text-white" : "text-black"
            }`}
          >
            heddle
          </span>
          <span
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide transition-colors duration-300 ${
              pastHero
                ? "border-white/20 text-white/60"
                : "border-black/20 text-black/50"
            }`}
          >
            BETA
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors ${
              pastHero
                ? "border-white/10 text-white/70 hover:border-white/20 hover:text-white"
                : "border-black/10 text-black/60 hover:border-black/20 hover:text-black"
            }`}
          >
            <Github className="h-4 w-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </div>
      </div>
    </motion.nav>
  );
}
