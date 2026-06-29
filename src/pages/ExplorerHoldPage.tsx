import { BellRing, ChevronLeft, Clock3, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ENV } from '@/env';

const launchSignals = [
  'Fresh launch window is being prepared',
  'Early followers will hear first',
  'Explorer reopens very soon',
] as const;

export default function ExplorerHoldPage() {
  return (
    <div className="content-grid py-10 md:py-16">
      <div className="relative overflow-hidden rounded-[28px] border border-primary/20 bg-card/75 px-6 py-8 shadow-[0_30px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl md:px-10 md:py-12">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(132,255,0,0.18),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(255,166,0,0.18),transparent_34%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(132,255,0,0.08),transparent_32%,rgba(255,166,0,0.08))]" />

        <div className="relative mx-auto max-w-5xl">
          <div className="mb-8 flex flex-wrap items-center gap-3 text-sm">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-2 text-primary">
              <Clock3 className="h-4 w-4" />
              {ENV.EXPLORER_HOLD_BADGE}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-muted-foreground">
              <Sparkles className="h-4 w-4 text-accent" />
              Launch mode in preparation
            </span>
          </div>

          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)] lg:items-center">
            <div>
              <p className="mb-4 text-sm uppercase tracking-[0.3em] text-primary/80">
                Explorer access
              </p>
              <h1 className="max-w-3xl text-4xl font-display font-bold tracking-tight text-foreground md:text-6xl">
                {ENV.EXPLORER_HOLD_TITLE}
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground md:text-lg">
                {ENV.EXPLORER_HOLD_MESSAGE}
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild size="lg" className="gap-2">
                  <a
                    href={ENV.EXPLORER_HOLD_PRIMARY_CTA_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <BellRing className="h-4 w-4" />
                    {ENV.EXPLORER_HOLD_PRIMARY_CTA_LABEL}
                  </a>
                </Button>
                <Button asChild size="lg" variant="outline" className="gap-2">
                  <Link to="/">
                    <ChevronLeft className="h-4 w-4" />
                    Back to landing
                  </Link>
                </Button>
              </div>
            </div>

            <Card className="card-elevated overflow-hidden bg-background/60">
              <CardContent className="p-6 md:p-7">
                <div className="mb-5 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.25em] text-muted-foreground">
                    Launch status
                  </span>
                  <span className="inline-flex h-3 w-3 rounded-full bg-primary shadow-[0_0_18px_rgba(132,255,0,0.95)]" />
                </div>

                <div className="space-y-4">
                  {launchSignals.map((signal, index) => (
                    <div
                      key={signal}
                      className="rounded-2xl border border-white/10 bg-white/5 p-4"
                    >
                      <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        Signal {index + 1}
                      </div>
                      <div className="mt-2 text-sm font-medium text-foreground">
                        {signal}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-6 rounded-2xl border border-primary/20 bg-primary/10 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-primary/80">
                    Heads-up
                  </div>
                  <p className="mt-2 text-sm leading-6 text-foreground/90">
                    Follow the launch channel so you do not miss the reopening. We will announce it there first.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
