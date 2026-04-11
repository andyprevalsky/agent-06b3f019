import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface TokenConsumptionCardProps {
  totalTokens: number;
}

export function TokenConsumptionCard({ totalTokens }: TokenConsumptionCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Total Tokens Consumed</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-4xl font-bold">{totalTokens.toLocaleString()}</p>
        <p className="text-sm text-muted-foreground mt-2">Across all agents and models</p>
      </CardContent>
    </Card>
  );
}
