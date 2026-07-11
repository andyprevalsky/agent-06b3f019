/**
 * STATE MACHINE: TaskEditModal
 *
 *   open(task) ──► editing (form state seeded from the task)
 *     editing ──user edits fields──► editing (dirty)
 *     editing ──Save──► saving ──PATCH ok──► closed (onSaved(updated))
 *                          │
 *                          └─PATCH fail──► editing (error banner, form kept)
 *     editing ──Cancel/backdrop──► closed (no mutation)
 *
 * Only metadata the backend allowlists is editable; tags are a chip editor
 * (enter to add, × to remove) so edits stay human-readable.
 */

import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { HubTask, HubTaskEdit } from '@/lib/api/benchmarksHub';
import { patchHubTask } from '@/lib/api/benchmarksHub';

interface TaskEditModalProps {
  task: HubTask;
  onClose: () => void;
  onSaved: (task: HubTask) => void;
}

export function TaskEditModal({ task, onClose, onSaved }: TaskEditModalProps) {
  const [title, setTitle] = useState(task.title ?? '');
  const [description, setDescription] = useState(task.description ?? '');
  const [prompt, setPrompt] = useState(task.prompt);
  const [tags, setTags] = useState<string[]>(task.tags);
  const [tagDraft, setTagDraft] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    task.timeout_seconds !== null ? String(task.timeout_seconds) : '',
  );
  const [priceLimitCents, setPriceLimitCents] = useState(
    task.price_limit_cents !== null ? String(task.price_limit_cents) : '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTag = () => {
    const value = tagDraft.trim();
    if (value !== '' && !tags.includes(value)) setTags([...tags, value]);
    setTagDraft('');
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const edit: HubTaskEdit = {};
    if (title !== (task.title ?? '') && title.trim() !== '') edit.title = title.trim();
    if (description !== (task.description ?? '')) edit.description = description;
    if (prompt !== task.prompt && prompt.trim() !== '') edit.prompt = prompt;
    if (JSON.stringify(tags) !== JSON.stringify(task.tags)) edit.tags = tags;
    const timeoutNum = timeoutSeconds.trim() === '' ? null : Number(timeoutSeconds);
    if (timeoutNum !== null && Number.isFinite(timeoutNum) && timeoutNum !== task.timeout_seconds) {
      edit.timeout_seconds = timeoutNum;
    }
    const priceNum = priceLimitCents.trim() === '' ? null : Number(priceLimitCents);
    if (priceNum !== null && Number.isFinite(priceNum) && priceNum !== task.price_limit_cents) {
      edit.price_limit_cents = priceNum;
    }
    if (Object.keys(edit).length === 0) {
      onClose();
      return;
    }
    try {
      const updated = await patchHubTask(task.name, edit);
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl" data-testid="task-edit-modal">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{task.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="hub-edit-title">Title</Label>
            <Input
              id="hub-edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="edit-title"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="hub-edit-description">Description</Label>
            <Textarea
              id="hub-edit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              data-testid="edit-description"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="hub-edit-prompt">Prompt</Label>
            <Textarea
              id="hub-edit-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              className="font-mono text-xs"
              data-testid="edit-prompt"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="hub-edit-tag-draft">Tags</Label>
            <div className="flex flex-wrap gap-1 pb-1">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1">
                  {tag}
                  <button
                    aria-label={`Remove tag ${tag}`}
                    onClick={() => setTags(tags.filter((t) => t !== tag))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <Input
              id="hub-edit-tag-draft"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="Add a tag, press Enter"
              data-testid="edit-tag-draft"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="hub-edit-timeout">Timeout (seconds)</Label>
              <Input
                id="hub-edit-timeout"
                type="number"
                min={1}
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(e.target.value)}
                data-testid="edit-timeout"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hub-edit-price">Price limit (cents)</Label>
              <Input
                id="hub-edit-price"
                type="number"
                min={0}
                value={priceLimitCents}
                onChange={(e) => setPriceLimitCents(e.target.value)}
                data-testid="edit-price"
              />
            </div>
          </div>

          {error !== null && (
            <div className="text-sm text-red-600" data-testid="edit-error">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving} data-testid="edit-save">
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
