import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="content-grid flex flex-1 flex-col items-center justify-center py-24 text-center">
      <p className="font-mono text-xs text-muted-foreground">404</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">There is nothing at this address</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">Everything lives on the home page.</p>
      <Button asChild className="mt-6">
        <Link to="/">Back to indexes</Link>
      </Button>
    </main>
  );
}
