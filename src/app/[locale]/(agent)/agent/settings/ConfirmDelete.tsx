'use client';

import { Button } from '@/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/ui/components/dialog';

// Удаление записи настроек с подтверждением (правило, адрес вебхука, макрос): окно поверх страницы, фокус внутри,
// Esc закрывает. Действие и скрытое поле с идентификатором задаёт страница.

export type ConfirmDeleteLabels = { open: string; title: string; text: string; confirm: string; cancel: string; close: string };

export function ConfirmDelete({ action, field, value, labels }: { action: (form: FormData) => Promise<void>; field: string; value: string; labels: ConfirmDeleteLabels }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="danger" className="self-start">
          {labels.open}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={labels.close}>
        <DialogTitle>{labels.title}</DialogTitle>
        <DialogDescription>{labels.text}</DialogDescription>
        <form action={action} className="flex flex-wrap justify-end gap-2">
          <input type="hidden" name={field} value={value} />
          <DialogClose asChild>
            <Button variant="secondary">{labels.cancel}</Button>
          </DialogClose>
          <Button type="submit" variant="danger">
            {labels.confirm}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
