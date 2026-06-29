import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { WalletButton } from '@/components/WalletButton';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

const NAV_ITEMS = [
  { path: '/explorer', label: 'Explore' },
  { path: '/builder', label: 'Builder' },
  { path: '/me', label: 'Baskets' },
];

export function Header() {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile menu on navigation
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <header className="sticky top-0 z-50 w-full bg-card/90 backdrop-blur-xl border-b border-primary/30 shadow-[0_0_20px_hsl(120_100%_50%_/_0.1)]">
      <div className="mx-auto flex h-16 w-full max-w-[1400px] min-w-0 items-center gap-6 px-4 md:px-6">
        {/* Logo */}
        <Link to="/" className="group flex shrink-0 items-center gap-1 xl:ml-32 2xl:ml-40">
          <img
            src="/poly-1.png"
            alt="PolyBaskets"
            className="h-[40px] w-[40px] shrink-0 object-contain drop-shadow-[0_0_12px_rgba(132,255,0,0.18)] lg:h-[60px] lg:w-[60px]"
          />
          <span className="hidden whitespace-nowrap font-display text-xl font-bold tracking-tight gradient-text transition-transform duration-300 group-hover:scale-105 xl:inline 2xl:text-2xl">PolyBaskets</span>
        </Link>

        {/* Desktop Navigation */}
        <nav className="hidden min-w-0 shrink-0 items-center gap-1 xl:flex 2xl:gap-2">
          {NAV_ITEMS.map(item => (
            <Link
              key={item.path}
              to={item.path}
              className={`relative rounded-md px-3 py-2 text-sm font-medium transition-all duration-200 lg:px-4 ${
                location.pathname === item.path
                  ? 'bg-primary text-primary-foreground shadow-[0_0_15px_hsl(120_100%_50%_/_0.4)]'
                  : 'text-muted-foreground hover:text-primary hover:bg-secondary/80 hover:shadow-[0_0_10px_hsl(120_100%_50%_/_0.2)]'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Right side */}
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2 xl:mr-40 xl:gap-3 2xl:mr-56">
          <div className="shrink-0">
            <WalletButton />
          </div>

          {/* Mobile hamburger */}
          <button
            className="flex min-h-[44px] min-w-[44px] items-center justify-center text-primary xl:hidden"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
          >
            <Menu className="h-6 w-6" />
          </button>
        </div>
      </div>

      {/* Mobile Sheet Navigation */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent
          side="right"
          className="bg-card border-l border-primary/30 shadow-[0_0_20px_hsl(120_100%_50%_/_0.1)] w-4/5 sm:max-w-sm p-0"
        >
          <SheetTitle className="sr-only">Navigation menu</SheetTitle>
          <nav className="flex flex-col pt-14 px-4">
            {NAV_ITEMS.map(item => (
              <Link
                key={item.path}
                to={item.path}
                className={`px-4 py-3 text-base font-medium rounded-md transition-all duration-200 ${
                  location.pathname === item.path
                    ? 'bg-primary text-primary-foreground shadow-[0_0_15px_hsl(120_100%_50%_/_0.4)]'
                    : 'text-muted-foreground hover:text-primary hover:bg-secondary/80'
                }`}
              >
                {item.label}
              </Link>
            ))}

            <div className="my-4 border-t border-border" />
          </nav>
        </SheetContent>
      </Sheet>
    </header>
  );
}
