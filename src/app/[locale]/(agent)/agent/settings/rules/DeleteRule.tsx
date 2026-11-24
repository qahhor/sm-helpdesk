'use client';

import { Button } from '@/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/ui/components/dialog';
import { deleteRuleAction } from './actions';

// Удаление правила с подтверждением (план M8, задача 4): окно поверх страницы, фокус внутри, Esc закрывает.
// Предустановленному правилу кнопка не показывается, сервис откажет и сам.

export type DeleteRuleLabels = { open: string; title: string; text: string; confirm: string; cancel: string; close: string };

export function DeleteRule({ ruleId, labels }: { ruleId: string; labels: DeleteRuleLabels }) {
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
        <form action={deleteRuleAction} className="flex flex-wrap justify-end gap-2">
          <input type="hidden" name="ruleId" value={ruleId} />
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
