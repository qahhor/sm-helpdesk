'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FilePicker, type FilePickerLabels } from '@/ui/components/file-picker';
import { Label } from '@/ui/components/label';
import { Textarea } from '@/ui/components/textarea';
import { browserDrafts, browserSession, clearDraft, type Draft, draftKey, forgetSent, rememberSent, saveDraft, useDraft } from '@/ui/drafts';
import { replyAction, type ReplyState } from './actions';

// Ответ клиента (FR-TK-08): текст с файлами, черновик на устройстве (UX-C-02), ошибка без потери текста (UX-C-10).

export type ReplyLabels = { reply: string; placeholder: string; send: string; busy: string; errors: Record<string, string>; files: FilePickerLabels };

const INITIAL: ReplyState = { error: null };

type ReplyProps = { userId: string; number: number; accept: string; maxFiles: number; labels: ReplyLabels; sent: boolean };

export function ReplyForm(props: ReplyProps) {
  const key = useMemo(() => draftKey(props.userId, `reply-${props.number}`), [props.userId, props.number]);
  // Ответ ушёл (страница открылась с ?done=replied): поле пустое, если на устройстве лежал именно отправленный текст.
  const { hydrated, draft } = useDraft(key, props.sent);
  return <Fields key={`${hydrated ? 'client' : 'server'}-${props.sent}`} {...props} draftKey={key} hydrated={hydrated} draft={draft} />;
}

function Fields({ number, accept, maxFiles, labels, draftKey: key, hydrated, draft }: ReplyProps & { draftKey: string; hydrated: boolean; draft: Draft | null }) {
  const [state, action, pending] = useActionState(replyAction, INITIAL);
  const [body, setBody] = useState(draft?.body ?? '');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    if (body.trim() === '') clearDraft(browserDrafts(), key);
    else saveDraft(browserDrafts(), key, { body });
  }, [hydrated, key, body, state]);
  useEffect(() => {
    if (state.error) forgetSent(browserSession(), key);
  }, [state, key]);

  const error = state.error ? (labels.errors[state.error] ?? labels.errors.invalid_input) : null;
  return (
    <form
      action={action}
      onSubmit={() => rememberSent(browserSession(), key, { body })}
      className="flex flex-col gap-3"
      noValidate
      data-ready={hydrated ? '' : undefined}
    >
      <input type="hidden" name="number" value={number} />
      {error && <Alert tone="danger">{error}</Alert>}
      <Label htmlFor="field-body">{labels.reply}</Label>
      <Textarea
        id="field-body"
        name="body"
        required
        maxLength={20000}
        placeholder={labels.placeholder}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className="min-h-24"
        aria-invalid={error ? true : undefined}
      />
      <FilePicker accept={accept} maxFiles={maxFiles} labels={labels.files} onBusyChange={setUploading} />
      {uploading && <p className="text-sm text-muted-foreground">{labels.busy}</p>}
      <Button type="submit" disabled={pending || uploading} className="self-end">
        {labels.send}
      </Button>
    </form>
  );
}
