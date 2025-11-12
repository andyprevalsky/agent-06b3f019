import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Linkedin, Twitter, MessageSquare, Mail, MessageCircle, Send, Instagram, Facebook, Chrome, type LucideIcon } from 'lucide-react';

interface Integration {
  name: string;
  description: string;
  Icon: LucideIcon;
}

export default function Integrations() {
  const integrations: Integration[] = [
    { name: 'LinkedIn', description: 'Import your LinkedIn connections and message history', Icon: Linkedin },
    { name: 'Twitter/X', description: 'Import your Twitter followers and direct messages', Icon: Twitter },
    { name: 'iMessage', description: 'Import your iMessage conversation history', Icon: MessageSquare },
    { name: 'Email', description: 'Connect your email to import contacts and threads', Icon: Mail },
    { name: 'WhatsApp', description: 'Import WhatsApp chat history', Icon: MessageCircle },
    { name: 'Telegram', description: 'Import Telegram contacts and messages', Icon: Send },
    { name: 'Instagram', description: 'Import Instagram connections and DMs', Icon: Instagram },
    { name: 'Facebook Messenger', description: 'Import Messenger conversations', Icon: Facebook },
    { name: 'Google', description: 'Import Google Contacts and Gmail history', Icon: Chrome },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="container max-w-3xl mx-auto py-12 px-4">
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Integrations</h1>
          <p className="text-muted-foreground">
            Connect your data sources to enhance your AI assistant's knowledge of your network
          </p>
        </div>

        <Card className="bg-[#EEEFF2]/80 dark:bg-[#1a1a1a]/80 backdrop-blur-[12px] border border-border dark:border-navi-light-light-black">
          <CardHeader>
            <CardTitle>Data Sources</CardTitle>
            <CardDescription>
              Import your connections and communication history from various platforms
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {integrations.map((integration) => {
                const Icon = integration.Icon;
                return (
                  <div
                    key={integration.name}
                    className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 flex items-center justify-center">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="font-medium">{integration.name}</h3>
                        <p className="text-sm text-muted-foreground">{integration.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                        Not Connected
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

