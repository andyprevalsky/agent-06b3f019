import { Loader2, Key, Trash2, Plus, ExternalLink, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import type { ApiKey } from '../types';
import { DOCS_URL } from '../config';

interface ApiKeysTabProps {
  loadingKeys: boolean;
  apiKeys: ApiKey[];
  newlyGeneratedKey: string | null;
  setNewlyGeneratedKey: (v: string | null) => void;
  showNewKeyForm: boolean;
  setShowNewKeyForm: (v: boolean) => void;
  newKeyName: string;
  setNewKeyName: (v: string) => void;
  generatingKey: boolean;
  deletingKeyId: string | null;
  onGenerateKeyClick: () => void;
  onGenerateApiKey: () => void;
  onDeleteApiKey: (keyId: string) => void;
  onCopyToClipboard: (text: string) => void;
}

function NewKeyAlert({
  apiKey,
  onCopyAndDismiss,
}: {
  apiKey: string;
  onCopyAndDismiss: () => void;
}) {
  return (
    <div className="p-4 bg-green-500/10 border border-green-500 rounded-lg space-y-3">
      <p className="text-sm font-medium text-green-600 dark:text-green-400">
        New API key generated! Copy it now - you won't see it again.
      </p>
      <code className="block p-3 bg-muted rounded text-sm font-mono break-all">{apiKey}</code>
      <Button size="sm" onClick={onCopyAndDismiss}>
        <Copy className="w-4 h-4 mr-2" />
        Copy & Dismiss
      </Button>
    </div>
  );
}

function KeyList({
  apiKeys,
  deletingKeyId,
  onDelete,
}: {
  apiKeys: ApiKey[];
  deletingKeyId: string | null;
  onDelete: (keyId: string) => void;
}) {
  if (apiKeys.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No API keys yet. Generate one to start using the Rose API.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {apiKeys.map((key) => (
        <div key={key.id} className="flex items-center justify-between p-3 border rounded-lg">
          <div>
            <p className="font-medium">{key.name || 'Unnamed'}</p>
            <p className="text-sm text-muted-foreground font-mono">{key.maskedApiKey}</p>
            <p className="text-xs text-muted-foreground">
              Created {new Date(key.createdAt).toLocaleDateString()}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(key.id)}
            disabled={deletingKeyId === key.id}
          >
            {deletingKeyId === key.id ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4 text-destructive" />
            )}
          </Button>
        </div>
      ))}
    </div>
  );
}

function NewKeyFormOrButton(
  props: Pick<
    ApiKeysTabProps,
    | 'showNewKeyForm'
    | 'setShowNewKeyForm'
    | 'newKeyName'
    | 'setNewKeyName'
    | 'generatingKey'
    | 'onGenerateKeyClick'
    | 'onGenerateApiKey'
  >,
) {
  if (props.showNewKeyForm) {
    return (
      <div className="space-y-3 pt-2 border-t">
        <Input
          placeholder="Key name (optional)"
          value={props.newKeyName}
          onChange={(e) => props.setNewKeyName(e.target.value)}
        />
        <div className="flex gap-2">
          <Button onClick={props.onGenerateApiKey} disabled={props.generatingKey}>
            {props.generatingKey ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Generate
          </Button>
          <Button variant="outline" onClick={() => props.setShowNewKeyForm(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <Button variant="outline" onClick={props.onGenerateKeyClick} className="w-full">
      <Plus className="w-4 h-4 mr-2" />
      Generate New Key
    </Button>
  );
}

export default function ApiKeysTab(props: ApiKeysTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Key className="w-5 h-5" />
          Rose API Keys
        </CardTitle>
        <CardDescription>API keys for accessing the Rose completions API</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.loadingKeys ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : (
          <>
            {props.newlyGeneratedKey && (
              <NewKeyAlert
                apiKey={props.newlyGeneratedKey}
                onCopyAndDismiss={() => {
                  props.onCopyToClipboard(props.newlyGeneratedKey!);
                  props.setNewlyGeneratedKey(null);
                }}
              />
            )}

            <KeyList
              apiKeys={props.apiKeys}
              deletingKeyId={props.deletingKeyId}
              onDelete={props.onDeleteApiKey}
            />

            <NewKeyFormOrButton
              showNewKeyForm={props.showNewKeyForm}
              setShowNewKeyForm={props.setShowNewKeyForm}
              newKeyName={props.newKeyName}
              setNewKeyName={props.setNewKeyName}
              generatingKey={props.generatingKey}
              onGenerateKeyClick={props.onGenerateKeyClick}
              onGenerateApiKey={props.onGenerateApiKey}
            />

            <div className="pt-4 border-t">
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline flex items-center gap-1"
              >
                <ExternalLink className="w-4 h-4" />
                View API Documentation
              </a>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
