import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  BookOpen, 
  Database, 
  Code2, 
  Calculator,
  Bot,
  Wallet,
  ArrowRight,
  ArrowDown,
  CheckCircle2,
  Clock,
  TrendingUp,
  TrendingDown,
  ExternalLink,
  Layers,
  Globe,
  Server,
  Cpu,
  Shield,
  Zap
} from "lucide-react";

// Diagram Components
function FlowBox({ children, color = "primary", className = "" }: { children: React.ReactNode; color?: string; className?: string }) {
  const colorClasses: Record<string, string> = {
    primary: "bg-primary/20 border-primary/50 text-primary",
    blue: "bg-blue-500/20 border-blue-500/50 text-blue-400",
    purple: "bg-purple-500/20 border-purple-500/50 text-purple-400",
    green: "bg-green-500/20 border-green-500/50 text-green-400",
    orange: "bg-orange-500/20 border-orange-500/50 text-orange-400",
    cyan: "bg-cyan-500/20 border-cyan-500/50 text-cyan-400",
    pink: "bg-pink-500/20 border-pink-500/50 text-pink-400",
    yellow: "bg-yellow-500/20 border-yellow-500/50 text-yellow-400",
    red: "bg-red-500/20 border-red-500/50 text-red-400",
  };
  
  return (
    <div className={`px-4 py-3 rounded-lg border-2 font-medium text-center ${colorClasses[color]} ${className}`}>
      {children}
    </div>
  );
}

function FlowArrow({ direction = "right" }: { direction?: "right" | "down" }) {
  return direction === "right" 
    ? <ArrowRight className="w-6 h-6 text-muted-foreground shrink-0 mx-1" />
    : <ArrowDown className="w-6 h-6 text-muted-foreground shrink-0 my-1" />;
}

function DiagramSection({ children, title, className = "" }: { children: React.ReactNode; title: string; className?: string }) {
  return (
    <div className={`p-4 rounded-xl border border-border/50 bg-card/50 ${className}`}>
      <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-4 px-2">{title}</div>
      {children}
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="container max-w-6xl mx-auto py-8 px-4 space-y-16">
      {/* Header */}
      <div className="text-center space-y-4">
        <Badge variant="outline" className="text-sm px-4 py-1">Documentation v1.0</Badge>
        <h1 className="text-3xl md:text-5xl font-bold bg-gradient-to-r from-primary via-green-400 to-emerald-500 bg-clip-text text-transparent">
          PolyBaskets Docs
        </h1>
        <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
          Complete technical documentation for understanding how PolyBaskets works end-to-end.
        </p>
      </div>

      {/* Quick Navigation */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { id: "diagrams", label: "Visual Diagrams", icon: <Layers className="w-4 h-4" /> },
          { id: "overview", label: "Overview", icon: <BookOpen className="w-4 h-4" /> },
          { id: "user-flow", label: "User Flow", icon: <Workflow className="w-4 h-4" /> },
          { id: "architecture", label: "Architecture", icon: <Layers className="w-4 h-4" /> },
          { id: "smart-contract", label: "Smart Contract", icon: <Code2 className="w-4 h-4" /> },
          { id: "index-calc", label: "Index Calculation", icon: <Calculator className="w-4 h-4" /> },
          { id: "payout", label: "Payout Formula", icon: <TrendingUp className="w-4 h-4" /> },
          { id: "settler-bot", label: "Settler On-chain", icon: <Bot className="w-4 h-4" /> },
        ].map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/60 border border-border/50 hover:border-primary/50 transition-all"
          >
            <div className="text-primary">{item.icon}</div>
            <span className="font-medium text-sm">{item.label}</span>
          </a>
        ))}
      </div>

      {/* ==================== VISUAL DIAGRAMS ==================== */}
      <section id="diagrams" className="scroll-mt-20 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-pink-500/20 flex items-center justify-center">
            <Layers className="w-5 h-5 text-pink-400" />
          </div>
          <h2 className="text-3xl font-bold">Visual Diagrams</h2>
        </div>
        
        <Card className="overflow-hidden border-2 border-pink-500/20">
          <CardContent className="pt-6">
            <p className="text-muted-foreground mb-6">
              Interactive diagrams to understand PolyBaskets architecture and flow. Click to open in FigJam and explore.
            </p>
            
            <div className="grid md:grid-cols-3 gap-4">
              {/* System Architecture */}
              <a 
                href="https://www.figma.com/board/S1IOsGZYdk5KwHelo7QKnJ/PolyBaskets---System-Overview?node-id=0-1&p=f&t=iZhaFM9Tta0kzvQE-0" 
                target="_blank" 
                rel="noopener noreferrer"
                className="group p-6 rounded-xl bg-gradient-to-br from-blue-500/10 to-purple-500/10 border-2 border-blue-500/30 hover:border-blue-500/60 transition-all"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                    <Layers className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <h3 className="font-bold text-blue-400">System Architecture</h3>
                    <p className="text-xs text-muted-foreground">Frontend, Backend, Blockchain</p>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  • Frontend (React + Vite)<br/>
                  • External Services (Polymarket, RPC)<br/>
                  • Solana Smart Contract<br/>
                  • Settler On-chain Service
                </div>
                <div className="mt-4 flex items-center gap-2 text-xs text-blue-400 group-hover:underline">
                  <ExternalLink className="w-3 h-3" />
                  Open in FigJam
                </div>
              </a>

              {/* User Flow Sequence */}
              <a 
                href="https://www.figma.com/online-whiteboard/create-diagram/8d090402-161d-47df-91a1-1856a9d1e8b7" 
                target="_blank" 
                rel="noopener noreferrer"
                className="group p-6 rounded-xl bg-gradient-to-br from-green-500/10 to-cyan-500/10 border-2 border-green-500/30 hover:border-green-500/60 transition-all"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center">
                    <Workflow className="w-5 h-5 text-green-400" />
                  </div>
                  <div>
                    <h3 className="font-bold text-green-400">User Flow Sequence</h3>
                    <p className="text-xs text-muted-foreground">Step-by-step interaction</p>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  • User → Frontend interaction<br/>
                  • Frontend → Polymarket API<br/>
                  • Contract transactions<br/>
                  • Settlement & Claim flow
                </div>
                <div className="mt-4 flex items-center gap-2 text-xs text-green-400 group-hover:underline">
                  <ExternalLink className="w-3 h-3" />
                  Open in FigJam
                </div>
              </a>

              {/* Index Calculation */}
              <a 
                href="https://www.figma.com/online-whiteboard/create-diagram/ee323214-d7f9-4095-ba0c-428e1df34229" 
                target="_blank" 
                rel="noopener noreferrer"
                className="group p-6 rounded-xl bg-gradient-to-br from-orange-500/10 to-yellow-500/10 border-2 border-orange-500/30 hover:border-orange-500/60 transition-all"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-orange-500/20 flex items-center justify-center">
                    <Calculator className="w-5 h-5 text-orange-400" />
                  </div>
                  <div>
                    <h3 className="font-bold text-orange-400">Index Calculation</h3>
                    <p className="text-xs text-muted-foreground">Markets → Weights → Result</p>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  • Selected Markets with prices<br/>
                  • Assigned Weights (40%, 35%, 25%)<br/>
                  • Calculation formula<br/>
                  • Final Index Result
                </div>
                <div className="mt-4 flex items-center gap-2 text-xs text-orange-400 group-hover:underline">
                  <ExternalLink className="w-3 h-3" />
                  Open in FigJam
                </div>
              </a>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ==================== SECTION 1: OVERVIEW ==================== */}
      <section id="overview" className="scroll-mt-20 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center">
            <BookOpen className="w-5 h-5 text-primary" />
          </div>
          <h2 className="text-3xl font-bold">What is PolyBaskets?</h2>
        </div>
        
        <Card className="overflow-hidden">
          <CardContent className="pt-6 space-y-6">
            <p className="text-lg leading-relaxed">
              <strong className="text-primary">PolyBaskets</strong> is a prediction market aggregator built on Solana. 
              It lets you create <span className="text-primary font-semibold">baskets</span> — portfolios of multiple 
              Polymarket outcomes with custom weights — and bet on them as a single position.
            </p>
            
            {/* Problem/Solution Visual */}
            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-red-400">
                  <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center">✗</div>
                  <h4 className="font-bold">The Problem</h4>
                </div>
                <div className="space-y-2 text-sm text-muted-foreground pl-10">
                  <p>• Betting on markets one at a time</p>
                  <p>• No diversified positions</p>
                  <p>• Managing multiple bets is complex</p>
                  <p>• No index-based prediction investing</p>
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-green-400">
                  <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">✓</div>
                  <h4 className="font-bold">The Solution</h4>
                </div>
                <div className="space-y-2 text-sm text-muted-foreground pl-10">
                  <p>• Bundle multiple markets into one basket</p>
                  <p>• Assign custom weights to each</p>
                  <p>• Single bet, single position to track</p>
                  <p>• Automatic settlement and payouts</p>
                </div>
              </div>
            </div>

            {/* One-liner */}
            <div className="p-4 bg-gradient-to-r from-primary/10 via-green-500/10 to-emerald-500/10 rounded-xl border border-primary/30">
              <p className="text-center font-medium">
                Think of it like <span className="text-primary">ETF investing</span>, but for prediction markets.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ==================== SECTION 2: USER FLOW ==================== */}
      <section id="user-flow" className="scroll-mt-20 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center">
            <Workflow className="w-5 h-5 text-blue-400" />
          </div>
          <h2 className="text-3xl font-bold">User Flow</h2>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-8">
            {/* Main Flow Diagram */}
            <div className="p-6 bg-muted/30 rounded-xl">
              <div className="flex flex-wrap items-center justify-center gap-2">
                <FlowBox color="blue">1. Connect Wallet</FlowBox>
                <FlowArrow />
                <FlowBox color="purple">2. Browse Markets</FlowBox>
                <FlowArrow />
                <FlowBox color="pink">3. Build Basket</FlowBox>
                <FlowArrow />
                <FlowBox color="orange">4. Place Bet</FlowBox>
                <FlowArrow />
                <FlowBox color="yellow">5. Wait</FlowBox>
                <FlowArrow />
                <FlowBox color="green">6. Claim Payout</FlowBox>
              </div>
            </div>

            {/* Detailed Steps */}
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                { step: 1, title: "Connect Wallet", desc: "Connect Phantom or Solflare to Solana", color: "blue" },
                { step: 2, title: "Browse Markets", desc: "View live Polymarket data with real-time prices", color: "purple" },
                { step: 3, title: "Build Basket", desc: "Select 2-5 markets, assign weights (must = 100%)", color: "pink" },
                { step: 4, title: "Place Bet", desc: "Send USDC to contract, entry index is locked on-chain", color: "orange" },
                { step: 5, title: "Wait for Resolution", desc: "Markets resolve on Polymarket (YES/NO)", color: "yellow" },
                { step: 6, title: "Claim Payout", desc: "After settlement finalized, claim your USDC", color: "green" },
              ].map((item) => (
                <div key={item.step} className="p-4 bg-muted/30 rounded-lg border border-border/50">
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`w-6 h-6 rounded-full bg-${item.color}-500/20 flex items-center justify-center text-${item.color}-400 text-xs font-bold`}>
                      {item.step}
                    </div>
                    <h4 className="font-semibold">{item.title}</h4>
                  </div>
                  <p className="text-sm text-muted-foreground">{item.desc}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ==================== SECTION 3: ARCHITECTURE ==================== */}
      <section id="architecture" className="scroll-mt-20 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center">
            <Layers className="w-5 h-5 text-purple-400" />
          </div>
          <h2 className="text-3xl font-bold">System Architecture</h2>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-6">
            {/* Architecture Diagram */}
            <div className="p-6 bg-muted/30 rounded-xl space-y-6">
              
              {/* Top Row: External + Frontend */}
              <div className="grid md:grid-cols-2 gap-6">
                <DiagramSection title="External Data Source">
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 p-3 bg-cyan-500/10 rounded-lg border border-cyan-500/30">
                      <Globe className="w-5 h-5 text-cyan-400" />
                      <div>
                        <p className="font-semibold text-cyan-400">Polymarket API</p>
                        <p className="text-xs text-muted-foreground">Live market prices & resolutions</p>
                      </div>
                    </div>
                    <div className="flex justify-center">
                      <FlowArrow direction="down" />
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="p-2 bg-background rounded text-center">YES/NO Prices</div>
                      <div className="p-2 bg-background rounded text-center">Market Status</div>
                    </div>
                  </div>
                </DiagramSection>

                <DiagramSection title="Frontend (React + Vite)">
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 p-3 bg-blue-500/10 rounded-lg border border-blue-500/30">
                      <Code2 className="w-5 h-5 text-blue-400" />
                      <div>
                        <p className="font-semibold text-blue-400">Web Application</p>
                        <p className="text-xs text-muted-foreground">User interface & wallet connection</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="p-2 bg-background rounded text-center">React Query</div>
                      <div className="p-2 bg-background rounded text-center">Sails.js Client</div>
                      <div className="p-2 bg-background rounded text-center">TailwindCSS</div>
                      <div className="p-2 bg-background rounded text-center">shadcn/ui</div>
                    </div>
                  </div>
                </DiagramSection>
              </div>

              {/* Arrow Down */}
              <div className="flex justify-center">
                <FlowArrow direction="down" />
              </div>

              {/* Blockchain Section */}
              <DiagramSection title="Solana (Blockchain)">
                <div className="flex items-center gap-3 p-3 bg-purple-500/10 rounded-lg border border-purple-500/30 mb-4">
                  <Cpu className="w-5 h-5 text-purple-400" />
                  <div>
                    <p className="font-semibold text-purple-400">Smart Contract (Rust + Sails)</p>
                    <p className="text-xs text-muted-foreground">On-chain logic and storage</p>
                  </div>
                </div>
                
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="p-3 bg-background rounded-lg border border-border/50">
                    <div className="flex items-center gap-2 mb-2">
                      <Database className="w-4 h-4 text-primary" />
                      <span className="font-semibold text-sm">Baskets</span>
                    </div>
                    <div className="text-xs text-muted-foreground space-y-1">
                      <p>• id: u64</p>
                      <p>• creator: ActorId</p>
                      <p>• items: Vec</p>
                      <p>• status: enum</p>
                    </div>
                  </div>
                  
                  <div className="p-3 bg-background rounded-lg border border-border/50">
                    <div className="flex items-center gap-2 mb-2">
                      <Wallet className="w-4 h-4 text-primary" />
                      <span className="font-semibold text-sm">Positions</span>
                    </div>
                    <div className="text-xs text-muted-foreground space-y-1">
                      <p>• user: ActorId</p>
                      <p>• shares: u128</p>
                      <p>• entry_index: u16</p>
                      <p>• claimed: bool</p>
                    </div>
                  </div>
                  
                  <div className="p-3 bg-background rounded-lg border border-border/50">
                    <div className="flex items-center gap-2 mb-2">
                      <CheckCircle2 className="w-4 h-4 text-primary" />
                      <span className="font-semibold text-sm">Settlements</span>
                    </div>
                    <div className="text-xs text-muted-foreground space-y-1">
                      <p>• resolutions: Vec</p>
                      <p>• payout_per_share</p>
                      <p>• deadline: u64</p>
                      <p>• status: enum</p>
                    </div>
                  </div>
                </div>
              </DiagramSection>

              {/* Settler On-chain */}
              <DiagramSection title="Settler On-chain (Node.js Worker)">
                <div className="flex items-center gap-3 p-3 bg-green-500/10 rounded-lg border border-green-500/30 mb-4">
                  <Bot className="w-5 h-5 text-green-400" />
                  <div>
                    <p className="font-semibold text-green-400">Background Service</p>
                    <p className="text-xs text-muted-foreground">Monitors markets & settles baskets automatically</p>
                  </div>
                </div>
                
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <div className="px-3 py-2 bg-background rounded text-xs">Poll Every 30s</div>
                  <FlowArrow />
                  <div className="px-3 py-2 bg-background rounded text-xs">Check Resolutions</div>
                  <FlowArrow />
                  <div className="px-3 py-2 bg-background rounded text-xs">Propose Settlement</div>
                  <FlowArrow />
                  <div className="px-3 py-2 bg-background rounded text-xs">Wait 12min</div>
                  <FlowArrow />
                  <div className="px-3 py-2 bg-background rounded text-xs">Finalize</div>
                </div>
              </DiagramSection>
            </div>

            {/* Data Flow Summary */}
            <div className="p-4 bg-muted/50 rounded-lg">
              <h4 className="font-semibold mb-2">Data Flow Summary</h4>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>1. <span className="text-cyan-400">Polymarket</span> → Frontend: Live prices</p>
                <p>2. <span className="text-blue-400">Frontend</span> → Contract: Create basket, place bet, claim</p>
                <p>3. <span className="text-cyan-400">Polymarket</span> → <span className="text-green-400">Settler On-chain</span>: Market resolutions</p>
                <p>4. <span className="text-green-400">Settler On-chain</span> → Contract: Propose & finalize settlements</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ==================== SECTION 4: SMART CONTRACT ==================== */}
      <section id="smart-contract" className="scroll-mt-20 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center">
            <Code2 className="w-5 h-5 text-orange-400" />
          </div>
          <h2 className="text-3xl font-bold">Smart Contract</h2>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-8">
            {/* Contract State Diagram */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Contract State</h3>
              <div className="p-6 bg-muted/30 rounded-xl">
                <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  {[
                    { name: "baskets", type: "Map<u64, Basket>", desc: "All created baskets" },
                    { name: "positions", type: "Map<Key, Position>", desc: "User bet positions" },
                    { name: "settlements", type: "Map<u64, Settlement>", desc: "Settlement results" },
                    { name: "settler_role", type: "ActorId", desc: "Authorized settler" },
                    { name: "liveness_seconds", type: "u64 (720)", desc: "12min challenge window" },
                  ].map((item, i) => (
                    <div key={i} className="p-3 bg-background rounded-lg border border-primary/30">
                      <p className="font-mono text-primary text-sm font-semibold">{item.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground mt-1">{item.type}</p>
                      <p className="text-xs text-muted-foreground mt-2">{item.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Structs */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Data Structures</h3>
              <div className="grid md:grid-cols-3 gap-4">
                {/* Basket Struct */}
                <div className="p-4 bg-blue-500/10 border border-blue-500/30 rounded-xl">
                  <h4 className="font-bold text-blue-400 mb-3 flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    Basket
                  </h4>
                  <div className="space-y-2 font-mono text-xs">
                    <div className="flex justify-between"><span className="text-muted-foreground">id:</span><span>u64</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">creator:</span><span>ActorId</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">name:</span><span>String</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">items:</span><span>Vec&lt;BasketItem&gt;</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">status:</span><span>Active | Settled</span></div>
                  </div>
                </div>

                {/* Position Struct */}
                <div className="p-4 bg-purple-500/10 border border-purple-500/30 rounded-xl">
                  <h4 className="font-bold text-purple-400 mb-3 flex items-center gap-2">
                    <Wallet className="w-4 h-4" />
                    Position
                  </h4>
                  <div className="space-y-2 font-mono text-xs">
                    <div className="flex justify-between"><span className="text-muted-foreground">user:</span><span>ActorId</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">shares:</span><span>u128</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">index_at_creation:</span><span>u16 (bps)</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">claimed:</span><span>bool</span></div>
                  </div>
                </div>

                {/* Settlement Struct */}
                <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-xl">
                  <h4 className="font-bold text-green-400 mb-3 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" />
                    Settlement
                  </h4>
                  <div className="space-y-2 font-mono text-xs">
                    <div className="flex justify-between"><span className="text-muted-foreground">item_resolutions:</span><span>Vec</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">payout_per_share:</span><span>u128</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">challenge_deadline:</span><span>u64</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">status:</span><span>Proposed | Finalized</span></div>
                  </div>
                </div>
              </div>
            </div>

            {/* Methods */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Contract Methods</h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {[
                  { name: "create_basket()", desc: "Create new basket with markets + weights", who: "Anyone" },
                  { name: "bet_on_basket()", desc: "Place bet, stores position with entry index", who: "Anyone" },
                  { name: "propose_settlement()", desc: "Submit market resolutions", who: "Settler Only" },
                  { name: "finalize_settlement()", desc: "Finalize after challenge window", who: "Settler Only" },
                  { name: "claim()", desc: "Claim payout after finalization", who: "Position Owner" },
                  { name: "get_basket()", desc: "Query basket details", who: "Anyone (Read)" },
                ].map((method, i) => (
                  <div key={i} className="p-3 bg-muted/50 rounded-lg border border-border/50">
                    <p className="font-mono text-primary text-sm">{method.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">{method.desc}</p>
                    <Badge variant="outline" className="mt-2 text-[10px]">{method.who}</Badge>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ==================== SECTION 5: INDEX CALCULATION ==================== */}
      <section id="index-calc" className="scroll-mt-20 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/20 flex items-center justify-center">
            <Calculator className="w-5 h-5 text-cyan-400" />
          </div>
          <h2 className="text-3xl font-bold">Index Calculation</h2>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-8">
            {/* Formula */}
            <div className="p-6 bg-gradient-to-r from-primary/10 to-cyan-500/10 rounded-xl border border-primary/30">
              <p className="text-center font-mono text-2xl font-bold">
                Index = Σ (Weight × Probability)
              </p>
            </div>

            {/* Visual Example */}
            <div className="p-6 bg-muted/30 rounded-xl space-y-6">
              <h4 className="font-semibold text-center">Example Calculation</h4>
              
              {/* Markets */}
              <div className="grid md:grid-cols-3 gap-4">
                {[
                  { market: "BTC > $100k", weight: "40%", price: "75%", color: "orange" },
                  { market: "ETH > $5k", weight: "35%", price: "52%", color: "blue" },
                  { market: "AI Regulation", weight: "25%", price: "60%", color: "purple" },
                ].map((item, i) => (
                  <div key={i} className={`p-4 bg-${item.color}-500/10 border border-${item.color}-500/30 rounded-lg`}>
                    <p className="font-semibold text-sm">{item.market}</p>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <div className="p-2 bg-background rounded">
                        <p className="text-muted-foreground">Weight</p>
                        <p className="font-mono font-bold">{item.weight}</p>
                      </div>
                      <div className="p-2 bg-background rounded">
                        <p className="text-muted-foreground">YES Price</p>
                        <p className="font-mono font-bold">{item.price}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Calculation */}
              <div className="flex justify-center">
                <FlowArrow direction="down" />
              </div>
              
              <div className="p-4 bg-background rounded-xl max-w-md mx-auto">
                <div className="space-y-2 font-mono text-sm">
                  <p><span className="text-orange-400">0.40</span> × <span className="text-muted-foreground">0.75</span> = <span className="text-primary">0.300</span></p>
                  <p><span className="text-blue-400">0.35</span> × <span className="text-muted-foreground">0.52</span> = <span className="text-primary">0.182</span></p>
                  <p><span className="text-purple-400">0.25</span> × <span className="text-muted-foreground">0.60</span> = <span className="text-primary">0.150</span></p>
                  <div className="pt-2 border-t">
                    <p className="font-bold text-lg">Entry Index = <span className="text-primary">0.632 (63.2%)</span></p>
                  </div>
                </div>
              </div>
            </div>

            {/* Entry vs Settlement */}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="p-4 bg-blue-500/10 border border-blue-500/30 rounded-xl">
                <h4 className="font-bold text-blue-400 mb-2">Entry Index</h4>
                <p className="text-sm text-muted-foreground">
                  Calculated when you place your bet using <strong>live Polymarket prices</strong>. 
                  This is locked on-chain as your "buy price".
                </p>
              </div>
              <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-xl">
                <h4 className="font-bold text-green-400 mb-2">Settlement Index</h4>
                <p className="text-sm text-muted-foreground">
                  Calculated when markets resolve. <strong>YES = 100%, NO = 0%</strong>. 
                  This determines your payout.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ==================== SECTION 6: PAYOUT FORMULA ==================== */}
      <section id="payout" className="scroll-mt-20 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-green-500/20 flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-green-400" />
          </div>
          <h2 className="text-3xl font-bold">Payout Formula</h2>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-8">
            {/* Formula */}
            <div className="p-6 bg-gradient-to-r from-green-500/10 to-emerald-500/10 rounded-xl border border-green-500/30">
              <p className="text-center font-mono text-2xl font-bold">
                Payout = Bet × (Settlement ÷ Entry)
              </p>
            </div>

            {/* Scenarios */}
            <div className="grid md:grid-cols-2 gap-6">
              {/* Profit */}
              <div className="p-6 bg-green-500/10 border-2 border-green-500/30 rounded-xl">
                <div className="flex items-center gap-2 mb-4">
                  <TrendingUp className="w-6 h-6 text-green-400" />
                  <h4 className="font-bold text-green-400 text-lg">Profit Scenario</h4>
                </div>
                
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="p-2 bg-background rounded">
                      <p className="text-muted-foreground text-xs">Entry Index</p>
                      <p className="font-mono font-bold">40%</p>
                    </div>
                    <div className="p-2 bg-background rounded">
                      <p className="text-muted-foreground text-xs">Settlement Index</p>
                      <p className="font-mono font-bold">100%</p>
                    </div>
                  </div>
                  
                  <div className="p-3 bg-background rounded text-center">
                    <p className="text-muted-foreground text-xs">Bet Amount</p>
                    <p className="font-mono font-bold text-lg">1000 USDC</p>
                  </div>
                  
                  <div className="p-3 bg-green-500/20 rounded">
                    <p className="font-mono text-sm text-center">1000 × (1.0 ÷ 0.4) = <span className="font-bold text-green-400">2500 USDC</span></p>
                  </div>
                  
                  <div className="text-center">
                    <Badge className="bg-green-500/20 text-green-400 text-lg px-4 py-1">+150% Profit</Badge>
                  </div>
                </div>
              </div>

              {/* Loss */}
              <div className="p-6 bg-red-500/10 border-2 border-red-500/30 rounded-xl">
                <div className="flex items-center gap-2 mb-4">
                  <TrendingDown className="w-6 h-6 text-red-400" />
                  <h4 className="font-bold text-red-400 text-lg">Loss Scenario</h4>
                </div>
                
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="p-2 bg-background rounded">
                      <p className="text-muted-foreground text-xs">Entry Index</p>
                      <p className="font-mono font-bold">80%</p>
                    </div>
                    <div className="p-2 bg-background rounded">
                      <p className="text-muted-foreground text-xs">Settlement Index</p>
                      <p className="font-mono font-bold">50%</p>
                    </div>
                  </div>
                  
                  <div className="p-3 bg-background rounded text-center">
                    <p className="text-muted-foreground text-xs">Bet Amount</p>
                    <p className="font-mono font-bold text-lg">1000 USDC</p>
                  </div>
                  
                  <div className="p-3 bg-red-500/20 rounded">
                    <p className="font-mono text-sm text-center">1000 × (0.5 ÷ 0.8) = <span className="font-bold text-red-400">625 USDC</span></p>
                  </div>
                  
                  <div className="text-center">
                    <Badge className="bg-red-500/20 text-red-400 text-lg px-4 py-1">-37.5% Loss</Badge>
                  </div>
                </div>
              </div>
            </div>

            {/* Key Insight */}
            <div className="p-4 bg-primary/10 border border-primary/30 rounded-xl">
              <div className="flex items-start gap-3">
                <Zap className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Key Insight</p>
                  <p className="text-sm text-muted-foreground">
                    You profit when <strong>Settlement Index &gt; Entry Index</strong>. 
                    Bet when you think markets are undervalued (prices too low) and expect more YES outcomes!
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ==================== SECTION 7: SETTLER BOT ==================== */}
      <section id="settler-bot" className="scroll-mt-20 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
            <Bot className="w-5 h-5 text-emerald-400" />
          </div>
          <h2 className="text-3xl font-bold">Settler On-chain</h2>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-6">
            <p className="text-muted-foreground">
              The settler bot is a Node.js background service that runs 24/7, automatically 
              monitoring Polymarket and settling baskets when all markets resolve.
            </p>

            {/* Bot Flow Diagram */}
            <div className="p-6 bg-muted/30 rounded-xl">
              <div className="space-y-4">
                {[
                  { step: 1, title: "Poll Polymarket", desc: "Every 30 seconds, check all active baskets", icon: <Clock className="w-5 h-5" /> },
                  { step: 2, title: "Check Resolutions", desc: "For each basket, verify if all markets resolved (YES/NO)", icon: <CheckCircle2 className="w-5 h-5" /> },
                  { step: 3, title: "Propose Settlement", desc: "Submit item_resolutions and settlement index to contract", icon: <Server className="w-5 h-5" /> },
                  { step: 4, title: "Wait Challenge Period", desc: "Wait 12 minutes for potential disputes", icon: <Shield className="w-5 h-5" /> },
                  { step: 5, title: "Finalize Settlement", desc: "After deadline passes, finalize so users can claim", icon: <Zap className="w-5 h-5" /> },
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                      {item.icon}
                    </div>
                    <div className="flex-1 p-3 bg-background rounded-lg border border-border/50">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground">Step {item.step}</span>
                        <span className="font-semibold">{item.title}</span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">{item.desc}</p>
                    </div>
                    {i < 4 && <div className="hidden md:block"><FlowArrow direction="down" /></div>}
                  </div>
                ))}
              </div>
            </div>

            {/* Challenge Window */}
            <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl">
              <div className="flex items-start gap-3">
                <Shield className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-yellow-400">Why 12-Minute Challenge Window?</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    This is a safety mechanism. If the settler bot submits incorrect resolutions, 
                    anyone can dispute within 12 minutes. After the window passes without disputes, 
                    the settlement is considered valid and finalized.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ==================== SECTION 8: SECURITY ==================== */}
      <section id="security" className="scroll-mt-20 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center">
            <Shield className="w-5 h-5 text-red-400" />
          </div>
          <h2 className="text-3xl font-bold">Security Model</h2>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-6">
            <div className="grid md:grid-cols-2 gap-4">
              {[
                { 
                  title: "Authorized Settler", 
                  desc: "Only the designated settler_role can propose and finalize settlements. This prevents malicious actors from submitting fake results.",
                  icon: <Bot className="w-5 h-5" />
                },
                { 
                  title: "Challenge Window", 
                  desc: "12-minute delay before finalization allows for dispute if resolutions are incorrect.",
                  icon: <Clock className="w-5 h-5" />
                },
                { 
                  title: "On-Chain Positions", 
                  desc: "Your bet amount and entry index are stored immutably on Solana blockchain.",
                  icon: <Database className="w-5 h-5" />
                },
                { 
                  title: "Trustless Payouts", 
                  desc: "Payout calculation is deterministic based on on-chain data. No manual intervention.",
                  icon: <Calculator className="w-5 h-5" />
                },
              ].map((item, i) => (
                <div key={i} className="p-4 bg-muted/50 rounded-lg border border-border/50">
                  <div className="flex items-center gap-2 mb-2 text-primary">
                    {item.icon}
                    <h4 className="font-semibold">{item.title}</h4>
                  </div>
                  <p className="text-sm text-muted-foreground">{item.desc}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Footer */}
      <div className="text-center py-12 border-t border-border/50">
        <p className="text-muted-foreground mb-4">
          Built on <span className="text-primary">Solana</span> • Data from <span className="text-primary">Polymarket</span>
        </p>
        <div className="flex justify-center gap-6">
          <a 
            href="https://github.com/Adityaakr/polybaskets" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-sm text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
          >
            <ExternalLink className="w-3 h-3" /> GitHub
          </a>
          <a 
            href="https://solana.com" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-sm text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
          >
            <ExternalLink className="w-3 h-3" /> Solana
          </a>
          <a 
            href="https://polymarket.com" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-sm text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
          >
            <ExternalLink className="w-3 h-3" /> Polymarket
          </a>
        </div>
      </div>
    </div>
  );
}

// Missing icon component
function Workflow({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="8" height="8" x="3" y="3" rx="2"/>
      <path d="M7 11v4a2 2 0 0 0 2 2h4"/>
      <rect width="8" height="8" x="13" y="13" rx="2"/>
    </svg>
  );
}
