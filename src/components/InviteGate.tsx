import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowRight, Sparkles } from 'lucide-react';

// Valid invite codes
const VALID_CODES = [
  'POLYBASKET01',
  'POLYBASKET02', 
  'POLYBASKET03',
  'POLYBASKET04',
  'POLYBASKET05',
  'EARLYBIRD2024',
  'EARLYBIRD2025',
  'SOLPOLY001',
  'SOLPOLY002',
  'SOLPOLY003',
  'PREDICTION01',
  'PREDICTION02',
  'BETBASKET001',
  'BETBASKET002',
  'BETBASKET003',
  'ALPHAUSER001',
  'ALPHAUSER002',
  'ALPHAUSER003',
  'FOUNDER001',
  'FOUNDER002',
];

const STORAGE_KEY = 'polybaskets_access_granted';
const USED_CODES_KEY = 'polybaskets_used_codes';

// Get list of used codes from localStorage
function getUsedCodes(): string[] {
  try {
    const stored = localStorage.getItem(USED_CODES_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

// Mark a code as used
function markCodeAsUsed(code: string): void {
  const usedCodes = getUsedCodes();
  if (!usedCodes.includes(code)) {
    usedCodes.push(code);
    localStorage.setItem(USED_CODES_KEY, JSON.stringify(usedCodes));
  }
}

// Check if a code has been used
function isCodeUsed(code: string): boolean {
  return getUsedCodes().includes(code);
}

interface InviteGateProps {
  children: React.ReactNode;
}

export function InviteGate({ children }: InviteGateProps) {
  const [hasAccess, setHasAccess] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [isChecking, setIsChecking] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'true') {
      setHasAccess(true);
    }
    setIsChecking(false);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    await new Promise(resolve => setTimeout(resolve, 600));

    const trimmedCode = code.trim().toUpperCase();
    
    // Check if code is valid
    if (!VALID_CODES.includes(trimmedCode)) {
      setError('Invalid invite code');
      setCode('');
      setIsSubmitting(false);
      return;
    }
    
    // Check if code has already been used
    if (isCodeUsed(trimmedCode)) {
      setError('This code has already been used');
      setCode('');
      setIsSubmitting(false);
      return;
    }
    
    // Code is valid and unused - grant access and mark as used
    markCodeAsUsed(trimmedCode);
    localStorage.setItem(STORAGE_KEY, 'true');
    setHasAccess(true);
    setIsSubmitting(false);
  };

  if (isChecking) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a1a0a] via-[#0d1f0d] to-[#0a1a0a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-6">
          <div className="relative">
            <div className="absolute inset-0 bg-[hsl(120,100%,50%)] opacity-30 blur-3xl rounded-full scale-150" />
            <div className="relative w-20 h-20 rounded-2xl bg-white p-2 animate-pulse">
              <img src="/bask.png" alt="PolyBaskets" className="w-full h-full object-cover object-[center_20%] scale-125" />
            </div>
          </div>
          <div className="flex gap-1">
            <div className="w-2 h-2 rounded-full bg-[hsl(120,100%,50%)] animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-2 h-2 rounded-full bg-[hsl(120,100%,50%)] animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-2 h-2 rounded-full bg-[hsl(120,100%,50%)] animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      </div>
    );
  }

  if (hasAccess) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a1a0a] via-[#0d1f0d] to-[#081208] flex items-center justify-center p-4 overflow-hidden">
      {/* Animated background elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        {/* Radial gradient center */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-[hsl(120,100%,50%)] opacity-[0.04] blur-[200px] rounded-full" />
        
        {/* Floating orbs */}
        <div className="absolute top-20 left-20 w-64 h-64 bg-[hsl(120,80%,40%)] opacity-[0.06] blur-[100px] rounded-full animate-pulse" />
        <div className="absolute bottom-20 right-20 w-80 h-80 bg-[hsl(140,70%,35%)] opacity-[0.05] blur-[120px] rounded-full animate-pulse" style={{ animationDelay: '1s' }} />
        <div className="absolute top-1/3 right-1/4 w-40 h-40 bg-[hsl(100,90%,45%)] opacity-[0.04] blur-[80px] rounded-full animate-pulse" style={{ animationDelay: '2s' }} />
        
        {/* Subtle grid */}
        <div 
          className="absolute inset-0 opacity-[0.015]"
          style={{
            backgroundImage: `
              linear-gradient(hsl(120,100%,50%) 1px, transparent 1px),
              linear-gradient(90deg, hsl(120,100%,50%) 1px, transparent 1px)
            `,
            backgroundSize: '80px 80px',
          }}
        />
      </div>

      <div className="relative w-full max-w-md">
        {/* Card glow */}
        <div className="absolute -inset-4 bg-gradient-to-b from-[hsl(120,100%,50%,0.15)] via-[hsl(120,100%,50%,0.05)] to-transparent rounded-[40px] blur-2xl" />
        
        {/* Main card */}
        <div 
          className="relative rounded-3xl overflow-hidden"
          style={{
            background: 'linear-gradient(180deg, rgba(20,35,20,0.9) 0%, rgba(12,22,12,0.95) 100%)',
            boxShadow: '0 0 0 1px rgba(120,255,120,0.1), 0 25px 50px -12px rgba(0,0,0,0.5), 0 0 100px rgba(120,255,120,0.05)',
          }}
        >
          {/* Top glow line */}
          <div className="h-px w-full bg-gradient-to-r from-transparent via-[hsl(120,100%,60%,0.6)] to-transparent" />

          <div className="px-8 py-12 sm:px-12 sm:py-14">
            {/* Logo */}
            <div className="flex justify-center mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-[hsl(120,100%,50%)] opacity-40 blur-3xl rounded-full scale-[2]" />
                <div className="relative w-28 h-28 sm:w-32 sm:h-32 rounded-3xl bg-gradient-to-br from-[hsl(120,60%,20%)] to-[hsl(120,50%,12%)] p-1 shadow-2xl">
                  <div className="w-full h-full rounded-[20px] bg-white overflow-hidden">
                    <img 
                      src="/bask.png" 
                      alt="PolyBaskets" 
                      className="w-full h-full object-cover object-[center_20%] scale-125"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Title */}
            <div className="text-center mb-10">
              <h1 className="text-4xl sm:text-5xl font-bold text-white mb-4 tracking-tight">
                PolyBaskets
              </h1>
              <p className="text-[hsl(120,30%,60%)] text-lg">
              Curate Predict Profit
              </p>
            </div>

            {/* Early Access Badge */}
            <div className="flex justify-center mb-8">
              <div className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[hsl(120,100%,50%,0.1)] border border-[hsl(120,100%,50%,0.2)]">
                <Sparkles className="w-4 h-4 text-[hsl(120,100%,50%)]" />
                <span className="text-sm font-semibold text-[hsl(120,100%,50%)]">Early Access</span>
              </div>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <Input
                  type="text"
                  placeholder="Enter invite code"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.toUpperCase());
                    setError('');
                  }}
                  className="h-14 bg-[hsl(120,30%,8%)] border-[hsl(120,50%,20%,0.3)] text-white placeholder:text-[hsl(120,20%,40%)] text-center font-mono text-lg tracking-widest focus:border-[hsl(120,100%,50%,0.5)] focus:ring-2 focus:ring-[hsl(120,100%,50%,0.2)] rounded-xl transition-all"
                  maxLength={15}
                  autoFocus
                  disabled={isSubmitting}
                />
                {error && (
                  <p className="mt-3 text-sm text-[hsl(0,70%,60%)] text-center">
                    {error}
                  </p>
                )}
              </div>

              <Button 
                type="submit" 
                className="w-full h-14 bg-[hsl(120,100%,45%)] hover:bg-[hsl(120,100%,50%)] text-[hsl(120,100%,5%)] font-bold text-base rounded-xl transition-all duration-300 shadow-lg shadow-[hsl(120,100%,50%,0.25)] hover:shadow-[hsl(120,100%,50%,0.4)] hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100"
                disabled={!code.trim() || isSubmitting}
              >
                {isSubmitting ? (
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-[hsl(120,100%,5%,0.3)] border-t-[hsl(120,100%,5%)] rounded-full animate-spin" />
                    Verifying...
                  </div>
                ) : (
                  <>
                    Continue
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </>
                )}
              </Button>
            </form>
          </div>

          {/* Bottom accent */}
          <div className="h-px w-full bg-gradient-to-r from-transparent via-[hsl(120,50%,30%,0.3)] to-transparent" />
        </div>

        {/* Powered by */}
        <div className="mt-10 flex items-center justify-center gap-3">
          <span className="text-[hsl(120,20%,40%)] text-sm">Built on</span>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[hsl(120,40%,8%)] border border-[hsl(120,50%,20%,0.3)] hover:border-[hsl(120,100%,50%,0.3)] transition-colors">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#14F195]" />
            <span className="text-[hsl(120,60%,55%)] text-sm font-medium">Solana</span>
          </div>
        </div>
      </div>
    </div>
  );
}
