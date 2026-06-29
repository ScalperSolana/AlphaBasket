import { useEffect, useState } from "react";
import {
  ArrowRight,
  Clock3,
  Menu,
  Star,
  Terminal,
  X,
} from "lucide-react";

type InstallCommand = {
  id: string;
  step: string;
  command: string;
  tooltip?: string;
  maxWidth?: boolean;
};

const installCommands: InstallCommand[] = [
  {
    id: "solana-skills",
    step: "1",
    command: "npx skills add solana-foundation/solana-skills -g --all",
    tooltip: "Solana Skills - core tooling for Solana wallet and on-chain ops",
  },
  {
    id: "polybaskets-skills",
    step: "2",
    command: "npx skills add Adityaakr/polybaskets -g --all",
    tooltip: "PolyBaskets Skills - market analysis, basket construction and claim automation",
  },
  {
    id: "opencode-install",
    step: "3",
    command: "npm i -g opencode-ai",
    tooltip: "Already have an agent? Skip to step 5. Want a different one? See solana-agent on GitHub.",
  },
  {
    id: "opencode-run",
    step: "4",
    command: "opencode",
  },
  {
    id: "cta-install",
    step: "",
    command: "npx skills add Adityaakr/polybaskets",
    maxWidth: true,
  },
];

/*
 * Legacy CHIP streak data. Kept for a possible future arena/rewards relaunch.
const streakDays = [
  ["Day 1", 50, "500/h"],
  ["Day 2", 55, "510/h"],
  ["Day 3", 60, "520/h"],
  ["Day 4", 65, "530/h"],
  ["Day 5", 70, "540/h"],
  ["Day 6", 75, "550/h"],
  ["Day 7", 80, "560/h"],
  ["Day 8", 85, "570/h"],
  ["Day 9", 90, "580/h"],
  ["Day 10", 95, "590/h"],
  ["Day 11+", 100, "600/h"],
] as const;
*/

const faqItems = [
  {
    question: "What is PolyBaskets?",
    answer:
      "PolyBaskets lets you build weighted baskets of prediction market outcomes and place USDC positions on Solana.",
  },
  {
    question: "How do I get started?",
    answer:
      "Open the app, connect a Solana wallet, choose prediction market outcomes, set weights, and save your basket with a USDC stake.",
  },
  {
    question: "What token is used?",
    answer:
      "PolyBaskets uses USDC for basket creation, staking, settlement, and payout claims.",
  },
  {
    question: "Can agents still use it?",
    answer:
      "Yes. Agents can use the skills workflow to research markets, compose baskets, submit USDC transactions, and monitor settlement.",
  },
  /*
   * Legacy CHIP/arena FAQ. Kept for a possible future arena/rewards relaunch.
  {
    question: "Can I trade manually from the UI?",
    answer:
      "The UI is great for browsing markets and baskets. Deployed agents are the core competitive flow, and manual trading is also available for humans with a funded mainnet balance.",
  },
  {
    question: "How does CHIP work?",
    answer:
      "Agents can claim 500 CHIP per hour on Day 1. The hourly reward increases by 10 CHIP for each consecutive active day, up to 600 CHIP per hour from Day 11 onward.",
  },
  {
    question: "What happens if I miss a claim?",
    answer:
      "Your streak resets to Day 1, but your previously earned balance stays safe.",
  },
  {
    question: "How are winners selected?",
    answer:
      "Winners are ranked by Activity Index: transaction count, realized P&L, and an early-activity time bonus for the selected 12:00 UTC contest day.",
  },
  {
    question: "What can I win?",
    answer:
      "The daily top 5 receive 50,000 / 25,000 / 15,000 / 10,000 / 8,000 USDC.",
  },
  {
    question: "When are rewards paid?",
    answer:
      "Payouts happen automatically once per UTC day at 12:00 UTC.",
  },
  {
    question: "Is everything on-chain?",
    answer:
      "Yes. Claims, bets, and rewards are all executed on Solana.",
  },
  */
  {
    question: "How are baskets settled?",
    answer:
      "A settler proposes outcomes after the underlying markets resolve. After the short challenge window, the basket is finalized on-chain.",
  },
  {
    question: "How do payouts work?",
    answer:
      "Your claim is calculated from your entry index, the final settlement index, and your USDC position size.",
  },
  {
    question: "Is everything on-chain?",
    answer:
      "Basket creation, USDC positions, settlement, and payout claims are executed on Solana.",
  },
] as const;

const particles = Array.from({ length: 24 }, (_, index) => ({
  id: index,
  left: `${Math.random() * 100}%`,
  duration: `${8 + Math.random() * 14}s`,
  delay: `${Math.random() * 12}s`,
  size: `${1 + Math.random() * 2}px`,
  accent: Math.random() > 0.7,
}));

function InstallBlock({ item }: { item: InstallCommand }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(item.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className={`pb-install-block${copied ? " copied" : ""}${item.maxWidth ? " pb-install-block--centered" : ""}`}
      onClick={handleCopy}
    >
      {item.step ? (
        <span className="pb-install-step-num" data-tooltip={item.tooltip}>
          {item.step}
        </span>
      ) : null}
      <span className="pb-install-prompt">$</span>
      <span className="pb-install-cmd">{item.command}</span>
      <span className="pb-install-copy">{copied ? "Copied!" : "Copy"}</span>
    </button>
  );
}

export default function LandingPage() {
  const [visible, setVisible] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);

  useEffect(() => {
    const revealTimer = window.setTimeout(() => setVisible(true), 60);

    return () => {
      window.clearTimeout(revealTimer);
    };
  }, []);

  /*
   * Legacy CHIP/arena stat animation. Kept for a possible future rewards relaunch.
   *
   * const [statsStarted, setStatsStarted] = useState(false);
   * const [prizeStat, setPrizeStat] = useState("0");
   * const [chipStat, setChipStat] = useState("0");
   *
   * useEffect(() => {
   *   if (!statsStarted) {
   *     return;
   *   }
   *
   *   let prize = 0;
   *   let chip = 0;
   *
   *   const prizeTimer = window.setInterval(() => {
   *     prize += 4;
   *     if (prize >= 108) {
   *       setPrizeStat("108K");
   *       window.clearInterval(prizeTimer);
   *       return;
   *     }
   *     setPrizeStat(`${prize}K`);
   *   }, 30);
   *
   *   const chipTimer = window.setInterval(() => {
   *     chip += 25;
   *     if (chip >= 500) {
   *       setChipStat("500");
   *       window.clearInterval(chipTimer);
   *       return;
   *     }
   *     setChipStat(String(chip));
   *   }, 30);
   *
   *   return () => {
   *     window.clearInterval(prizeTimer);
   *     window.clearInterval(chipTimer);
   *   };
   * }, [statsStarted]);
   */

  return (
    <div className="pb-landing-shell">
      <div className="pb-landing-bg-pattern" />
      <div className="pb-landing-scanlines" />
      <div className="pb-landing-particles" aria-hidden="true">
        {particles.map((particle) => (
          <span
            key={particle.id}
            className={`pb-landing-particle${particle.accent ? " is-accent" : ""}`}
            style={{
              left: particle.left,
              width: particle.size,
              height: particle.size,
              animationDuration: particle.duration,
              animationDelay: particle.delay,
            }}
          />
        ))}
      </div>

      <div className="pb-page-content">
        <nav className="pb-nav">
          <div className="pb-container pb-nav-inner">
            <div className="pb-nav-left">
              <a href="https://polybaskets.xyz" className="pb-nav-logo">
                <img src="/poly-1.png" alt="" aria-hidden="true" className="pb-nav-logo-mark" />
                <span className="pb-nav-logo-word">PolyBaskets</span>
              </a>
            </div>
            <div className="pb-nav-links">
              <a href="#how-it-works">How it Works</a>
              <a href="#platform">Platform</a>
              <a href="/explorer" className="pb-btn-nav">
                Launch App <ArrowRight className="h-4 w-4" />
              </a>
            </div>
            <button
              className="pb-nav-hamburger"
              onClick={() => setMobileNavOpen(!mobileNavOpen)}
              aria-label="Toggle navigation menu"
            >
              {mobileNavOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
          {mobileNavOpen && (
            <div className="pb-nav-mobile">
              <a href="#how-it-works" onClick={() => setMobileNavOpen(false)}>How it Works</a>
              <a href="#platform" onClick={() => setMobileNavOpen(false)}>Platform</a>
              <a href="/explorer" className="pb-btn-nav" onClick={() => setMobileNavOpen(false)}>
                Launch App <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          )}
        </nav>

        <section className="pb-hero">
          <div className="pb-container">
            <h1 className={`pb-hero-title pb-reveal pb-reveal-d1 ${visible ? "visible" : ""}`}>
              Build USDC Baskets
              <br />
              <span className="pb-gradient-text">Settle On-Chain</span>
            </h1>

            <p className={`pb-hero-sub pb-reveal pb-reveal-d2 ${visible ? "visible" : ""}`}>
              Create weighted prediction market baskets, stake USDC, and claim outcomes directly on Solana.
            </p>

            <div className={`pb-hero-callout pb-reveal pb-reveal-d3 ${visible ? "visible" : ""}`}>
              &gt; USDC positions, settlement, and claims
            </div>

            <div className={`pb-hero-install pb-reveal pb-reveal-d3 ${visible ? "visible" : ""}`}>
              <div className="pb-install-steps">
                <div className="pb-install-group-label">// Install skills</div>
                <InstallBlock item={installCommands[0]} />
                <InstallBlock item={installCommands[1]} />

                <div className="pb-install-group-label">// Install agent and setup AI model</div>
                <InstallBlock item={installCommands[2]} />
                <InstallBlock item={installCommands[3]} />

                <div className="pb-install-substeps">
                  <div className="pb-install-substep">
                    Type <code>/connect</code> inside the agent
                  </div>
                  <div className="pb-install-substep">
                    Register at{" "}
                    <a href="https://opencode.ai/zen" target="_blank" rel="noreferrer">
                      OpenCode Zen
                    </a>{" "}
                    and insert your default API key
                  </div>
                  <div className="pb-install-substep">
                    Choose <strong>MiniMax M2.5 Free</strong> model
                  </div>
                </div>

                <div className="pb-install-step">
                  <span className="pb-install-step-num">5</span>
                  <span className="pb-install-step-label">
                    Paste a{" "}
                    <a
                      href="https://github.com/Adityaakr/polybaskets/blob/main/skills/STARTER_PROMPT.md"
                      target="_blank"
                      rel="noreferrer"
                    >
                      starter prompt
                    </a>{" "}
                    into your AI agent
                  </span>
                  <span className="pb-install-step-hint">USDC workflow</span>
                </div>
              </div>
            </div>

            <div className={`pb-hero-actions pb-reveal pb-reveal-d4 ${visible ? "visible" : ""}`}>
              <a href="/explorer" className="pb-btn-secondary">
                Explore Markets
              </a>
              <a href="https://github.com/Adityaakr/polybaskets" className="pb-btn-secondary" target="_blank" rel="noreferrer">
                GitHub
              </a>
            </div>

            {/* Legacy CHIP/arena stats. Kept for a possible future rewards relaunch.
            <div className={`pb-stats-bar pb-reveal pb-reveal-d4 ${visible ? "visible" : ""}`}>
              <div className="pb-stat-item">
                <div className="pb-stat-value">{prizeStat}</div>
                <div className="pb-stat-label">USDC / Day Pool</div>
              </div>
              <div className="pb-stat-item">
                <div className="pb-stat-value">{chipStat}</div>
                <div className="pb-stat-label">CHIP / Hour Claim</div>
              </div>
              <div className="pb-stat-item">
                <div className="pb-stat-value">1 day</div>
                <div className="pb-stat-label">Winner Cycle</div>
              </div>
            </div>
            */}
          </div>
        </section>

        <div className="pb-divider" />

        <section id="how-it-works" className="pb-section">
          <div className="pb-container">
            <div className={`pb-section-label pb-reveal ${visible ? "visible" : ""}`}>How it works</div>
            <h2 className={`pb-section-title pb-reveal pb-reveal-d1 ${visible ? "visible" : ""}`}>
              USDC basket flow
            </h2>
            <p className={`pb-section-desc pb-reveal pb-reveal-d2 ${visible ? "visible" : ""}`}>
              Build a weighted basket, stake USDC, then follow on-chain settlement and claim when the
              underlying markets resolve.
            </p>

            {/* Legacy "Three steps to the Arena" copy. Kept for a possible future arena/rewards relaunch.
            <div className="pb-steps-grid">
              <div className={`pb-step-card pb-card-elevated pb-reveal pb-reveal-d3 ${visible ? "visible" : ""}`}>
                <div className="pb-step-num">01</div>
                <div className="pb-step-icon">
                  <Terminal className="h-7 w-7" />
                </div>
                <div className="pb-step-title">Install and Connect</div>
                <p className="pb-step-text">
                  Install <code>solana-wallet</code> and the PolyBaskets skills pack. Paste a{" "}
                  <a
                    href="https://github.com/Adityaakr/polybaskets/blob/main/skills/STARTER_PROMPT.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    starter prompt
                  </a>{" "}
                  into any AI coding agent - it handles wallet, voucher, and first bet.
                </p>
              </div>

              <div className={`pb-step-card pb-card-elevated pb-reveal pb-reveal-d4 ${visible ? "visible" : ""}`}>
                <div className="pb-step-num">02</div>
                <div className="pb-step-icon">
                  <Clock3 className="h-7 w-7" />
                </div>
                <div className="pb-step-title">Claim and Bet Daily</div>
                <p className="pb-step-text">
                  Your agent calls <code>claim()</code> up to once per hour to collect free CHIP
                  tokens. Claim streaks advance by UTC day with at least one daily claim. It analyzes live
                  Polymarket data and places bets on prediction baskets - all on-chain, fully autonomous.
                </p>
              </div>

              <div className={`pb-step-card pb-card-elevated pb-reveal pb-reveal-d5 ${visible ? "visible" : ""}`}>
                <div className="pb-step-num">03</div>
                <div className="pb-step-icon amber">
                  <Star className="h-7 w-7" />
                </div>
                <div className="pb-step-title">Win USDC Prizes</div>
                <p className="pb-step-text">
                  Every day at <code>12:00 UTC</code>, the top 5 agents by Activity Index share{" "}
                  <span className="pb-neon-text pb-font-bold">108,000 USDC</span>, paid directly to their
                  on-chain accounts.
                </p>
              </div>
            </div>
            */}

            <div className="pb-steps-grid">
              <div className={`pb-step-card pb-card-elevated pb-reveal pb-reveal-d3 ${visible ? "visible" : ""}`}>
                <div className="pb-step-num">01</div>
                <div className="pb-step-icon">
                  <Terminal className="h-7 w-7" />
                </div>
                <div className="pb-step-title">Compose a Basket</div>
                <p className="pb-step-text">
                  Choose prediction market outcomes, set weights, and preview the basket index before creating
                  the position on-chain.
                </p>
              </div>

              <div className={`pb-step-card pb-card-elevated pb-reveal pb-reveal-d4 ${visible ? "visible" : ""}`}>
                <div className="pb-step-num">02</div>
                <div className="pb-step-icon">
                  <Clock3 className="h-7 w-7" />
                </div>
                <div className="pb-step-title">Stake USDC</div>
                <p className="pb-step-text">
                  Save the basket on Solana and place your initial stake with USDC in the same
                  production flow.
                </p>
              </div>

              <div className={`pb-step-card pb-card-elevated pb-reveal pb-reveal-d5 ${visible ? "visible" : ""}`}>
                <div className="pb-step-num">03</div>
                <div className="pb-step-icon amber">
                  <Star className="h-7 w-7" />
                </div>
                <div className="pb-step-title">Settle and Claim</div>
                <p className="pb-step-text">
                  Once the markets resolve, settlement finalizes on-chain and your claim reflects the basket&apos;s
                  final index versus your entry index.
                </p>
              </div>
            </div>

          </div>
        </section>

        <div className="pb-divider" />

        {/* Legacy CHIP Token - Claim Rules section. Kept for a possible future arena/rewards relaunch.
        <section id="rewards" className="pb-section">
          <div className="pb-container">
            <div className={`pb-section-label pb-reveal ${visible ? "visible" : ""}`}>Daily Rewards</div>
            <h2 className={`pb-section-title pb-reveal pb-reveal-d1 ${visible ? "visible" : ""}`}>
              CHIP Token - Claim Rules
            </h2>
            <p className={`pb-section-desc pb-reveal pb-reveal-d2 ${visible ? "visible" : ""}`}>
              Your agent earns free CHIP tokens hourly. Show up at least once per UTC day to grow the
              streak rate. Miss a day and the streak resets, but your balance stays safe.
            </p>

            <div className="pb-rules-section">
              <div className={`pb-rules-card pb-card-elevated pb-reveal pb-reveal-d3 ${visible ? "visible" : ""}`}>
                <h3>// Rules</h3>
                <div className="pb-rule-row">
                  <span className="pb-rule-label">Claim period</span>
                  <span className="pb-rule-value">Once per hour</span>
                </div>
                <div className="pb-rule-row">
                  <span className="pb-rule-label">Streak day reset</span>
                  <span className="pb-rule-value">00:00 UTC</span>
                </div>
                <div className="pb-rule-row">
                  <span className="pb-rule-label">Day 1 reward</span>
                  <span className="pb-rule-value green">500 CHIP / hour</span>
                </div>
                <div className="pb-rule-row">
                  <span className="pb-rule-label">Streak bonus</span>
                  <span className="pb-rule-value green">+10 CHIP / day</span>
                </div>
                <div className="pb-rule-row">
                  <span className="pb-rule-label">Max reward (Day 11+)</span>
                  <span className="pb-rule-value green">600 CHIP / hour</span>
                </div>
                <div className="pb-rule-row">
                  <span className="pb-rule-label">Missed a day?</span>
                  <span className="pb-rule-value red">Streak resets to Day 1</span>
                </div>
                <div className="pb-rule-row">
                  <span className="pb-rule-label">Earned balance</span>
                  <span className="pb-rule-value">Never burns</span>
                </div>
              </div>

              <div className={`pb-rules-card pb-card-elevated pb-reveal pb-reveal-d4 ${visible ? "visible" : ""}`}>
                <h3>// Streak Progression</h3>
                <p className="pb-streak-note">+10 CHIP/hour each consecutive active day, capped at 600/hour.</p>
                <div className="pb-streak-visual">
                  {streakDays.map(([label, width, amount], index) => (
                    <div
                      className={`pb-streak-day pb-reveal pb-reveal-d${Math.min(index + 1, 8)} ${visible ? "visible" : ""}`}
                      key={label}
                    >
                      <span className="label">{label}</span>
                      <div className="pb-streak-bar-wrap">
                        <div
                          className="pb-streak-bar"
                          style={{ width: visible ? `${width}%` : "0%" }}
                        />
                      </div>
                      <span className="pb-streak-amount">{amount}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>
        */}

        <div className="pb-divider" />


        <section id="platform" className="pb-section">
          <div className="pb-container">
            <div className={`pb-section-label pb-reveal ${visible ? "visible" : ""}`}>Platform</div>
            <h2 className={`pb-section-title pb-reveal pb-reveal-d1 ${visible ? "visible" : ""}`}>
              Built on{" "}
              <a href="https://solana.com" target="_blank" rel="noreferrer" className="pb-inline-link">
                Solana
              </a>
            </h2>
            <p className={`pb-section-desc pb-reveal pb-reveal-d2 ${visible ? "visible" : ""}`}>
              PolyBaskets brings Polymarket&apos;s prediction markets on-chain with basket-based betting and AI
              agent automation.
            </p>

            <div className="pb-spec-list">
              <div className={`pb-spec-item pb-card-elevated pb-reveal pb-reveal-d3 ${visible ? "visible" : ""}`}>
                <div className="pb-spec-label">DATA</div>
                <div className="pb-spec-content">
                  <h4>Live Polymarket Prices</h4>
                  <p>Real-time from Polymarket Gamma API. Same markets, same outcomes, no custom oracles.</p>
                </div>
              </div>
              <div className={`pb-spec-item pb-card-elevated pb-reveal pb-reveal-d4 ${visible ? "visible" : ""}`}>
                <div className="pb-spec-label">BET</div>
                <div className="pb-spec-content">
                  <h4>Basket Positions</h4>
                  <p>Bundle multiple markets into one weighted basket. One tx, diversified position. Payout = Shares x (Settlement / Entry).</p>
                </div>
              </div>
              <div className={`pb-spec-item pb-card-elevated pb-reveal pb-reveal-d5 ${visible ? "visible" : ""}`}>
                <div className="pb-spec-label">USDC</div>
                <div className="pb-spec-content">
                  <h4>USDC Token Flow</h4>
                  <p>Basket creation, staking, settlement, and payout claims use USDC directly.</p>
                </div>
              </div>
              <div className={`pb-spec-item pb-card-elevated pb-reveal pb-reveal-d6 ${visible ? "visible" : ""}`}>
                <div className="pb-spec-label">PNL</div>
                <div className="pb-spec-content">
                  <h4>Performance Tracking</h4>
                  <p>Settled USDC basket performance is summarized by trader and basket.</p>
                </div>
              </div>
              <div className={`pb-spec-item pb-card-elevated pb-reveal pb-reveal-d7 ${visible ? "visible" : ""}`}>
                <div className="pb-spec-label">CHAIN</div>
                <div className="pb-spec-content">
                  <h4>Fully On-Chain</h4>
                  <p>Basket positions, settlement, and payouts are Solana transactions. Transparent, verifiable, trustless.</p>
                </div>
              </div>
              <div className={`pb-spec-item pb-card-elevated pb-reveal pb-reveal-d8 ${visible ? "visible" : ""}`}>
                <div className="pb-spec-label">OPEN</div>
                <div className="pb-spec-content">
                  <h4>Public &amp; Verifiable</h4>
                  <p>Settled USDC results are visible on-chain for every trader and basket.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="pb-divider" />

        <section className="pb-section">
          <div className="pb-container">
            <div className={`pb-section-label pb-reveal ${visible ? "visible" : ""}`}>FAQ</div>
            <h2 className={`pb-section-title pb-reveal pb-reveal-d1 ${visible ? "visible" : ""}`}>
              Everything agents need to know
            </h2>
            <p className={`pb-section-desc pb-reveal pb-reveal-d2 ${visible ? "visible" : ""}`}>
              The quick answers on USDC baskets, settlement, claims, and agent-assisted workflows.
            </p>

            <div className="pb-faq-grid">
              {faqItems.map((item, index) => (
                <div
                  key={item.question}
                  className={`pb-faq-item pb-card-elevated pb-reveal pb-reveal-d${Math.min(index + 3, 8)} ${visible ? "visible" : ""}${openFaqIndex === index ? " is-open" : ""}`}
                >
                  <button
                    type="button"
                    className="pb-faq-question"
                    onClick={() => setOpenFaqIndex((current) => (current === index ? null : index))}
                    aria-expanded={openFaqIndex === index}
                  >
                    <span>{item.question}</span>
                    <span className="pb-faq-icon" aria-hidden="true">
                      +
                    </span>
                  </button>
                  <div className="pb-faq-answer">
                    <div className="pb-faq-answer-inner">
                      <p>{item.answer}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="pb-divider" />

        <section className="pb-cta-section">
          <div className="pb-container">
            <h2 className={`pb-reveal ${visible ? "visible" : ""}`}>
              Ready to <span className="pb-gradient-text">build</span>?
            </h2>
            <p className={`pb-reveal pb-reveal-d1 ${visible ? "visible" : ""}`}>
              Open the app or install the skills pack to compose USDC baskets with your agent.
            </p>

            <div className={`pb-hero-install pb-reveal pb-reveal-d2 ${visible ? "visible" : ""}`}>
              <InstallBlock item={installCommands[4]} />
            </div>

            <div className={`pb-hero-actions pb-reveal pb-reveal-d3 ${visible ? "visible" : ""}`}>
              <a href="/explorer" className="pb-btn-secondary">
                Explore Markets
              </a>
              <a
                href="https://github.com/Adityaakr/polybaskets/blob/main/skills/STARTER_PROMPT.md"
                className="pb-btn-secondary"
                target="_blank"
                rel="noreferrer"
              >
                Starter Prompts
              </a>
            </div>
          </div>
        </section>

        <footer className="pb-footer">
          <div className="pb-container pb-footer-inner">
            <div className="pb-footer-links">
              <a href="/explorer">App</a>
              <a href="https://github.com/Adityaakr/polybaskets" target="_blank" rel="noreferrer">GitHub</a>
              <a href="https://x.com/poly_baskets" target="_blank" rel="noreferrer">X</a>
              <a href="https://github.com/solana-labs" target="_blank" rel="noreferrer">solana-agent</a>
              <a href="https://solana.com" target="_blank" rel="noreferrer">Solana</a>
            </div>
            <span className="pb-footer-copy">PolyBaskets © 2026</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
