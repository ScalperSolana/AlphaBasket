import { AlertCircle, Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

/**
 * Says which endpoint failed and why.
 *
 * A generic "something went wrong" would be useless during a hybrid deployment,
 * where the usual cause is that the backend is not running or `VITE_INDEX_API_URL`
 * points somewhere else.
 */
export function ErrorState({ error }: { error: string }) {
  return (
    <Alert variant="destructive" className="my-8">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Could not load</AlertTitle>
      <AlertDescription className="font-mono text-xs">{error}</AlertDescription>
    </Alert>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="text-center py-16 border border-dashed rounded-lg">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
        {description}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
