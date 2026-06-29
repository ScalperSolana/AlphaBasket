import { Bot, TerminalSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type AgentTradingNoticeProps = {
  title?: string;
  description?: string;
};

export function AgentTradingNotice({
  title = 'Agent-only execution',
  description = 'This action is available through your agent only.',
}: AgentTradingNoticeProps) {
  return (
    <Card className="card-elevated border-primary/20">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 text-primary" />
            {title}
          </CardTitle>
          <Badge variant="outline" className="border-primary/20 text-primary">
            Agent only
          </Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-start gap-3 text-sm text-muted-foreground">
        <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <p>
          Browse baskets and monitor outcomes here, but send transactional actions through your agent stack.
        </p>
      </CardContent>
    </Card>
  );
}
