import { cn } from "@/lib/utils.ts";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-xl bg-muted/80", className)} aria-hidden {...props} />;
}

export { Skeleton };
