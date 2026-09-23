import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: {
        "2xl": "1280px",
      },
    },
    extend: {
      fontFamily: {
        sans: ['"Manrope"', "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        display: ['"Manrope"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', '"SF Mono"', "Menlo", "ui-monospace", "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      // One radius scale, derived from --radius (16px): sm 8, md 12, lg 16,
      // xl 20, 2xl 24. Cards use 2xl, controls use xl, chips use full.
      borderRadius: {
        sm: "calc(var(--radius) - 8px)",
        md: "calc(var(--radius) - 4px)",
        lg: "var(--radius)",
        xl: "calc(var(--radius) + 4px)",
        "2xl": "calc(var(--radius) + 8px)",
        "3xl": "calc(var(--radius) + 16px)",
      },
      boxShadow: {
        soft: "0 1px 2px rgb(0 0 0 / 0.35), 0 8px 24px -12px rgb(0 0 0 / 0.5)",
        panel: "-24px 0 80px -32px hsl(var(--primary) / 0.22), 0 24px 64px -24px rgb(0 0 0 / 0.7)",
        // Glows. One hue, three strengths: resting control, hovered control,
        // hovered or selected card.
        glow: "0 0 20px -4px hsl(var(--primary) / 0.35)",
        "glow-lg": "0 0 36px -6px hsl(var(--primary) / 0.5)",
        "glow-ring": "0 0 0 1px hsl(var(--primary) / 0.45), 0 16px 48px -16px hsl(var(--primary) / 0.4)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "grow-x": {
          from: { transform: "scaleX(0)" },
          to: { transform: "scaleX(1)" },
        },
        "pulse-dot": {
          "0%, 100%": { boxShadow: "0 0 0 0 hsl(var(--success) / 0.5)" },
          "70%": { boxShadow: "0 0 0 5px hsl(var(--success) / 0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.2s ease-out both",
        "rise-in": "rise-in 0.25s cubic-bezier(0, 0, 0.2, 1) both",
        "grow-x": "grow-x 0.5s cubic-bezier(0, 0, 0.2, 1) both",
        "pulse-dot": "pulse-dot 2.4s ease-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
