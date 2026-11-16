"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { NEW_DIALOG_CONFIRM } from "@/lib/answer-ux";

/** «Новый диалог» с подтверждением (T31): в текущем диалоге есть начатая, но не отправленная заявка. */
export function NewDialogConfirm({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-[420px]">
        <div className="grid gap-1.5 pr-8">
          <DialogTitle className="font-heading text-[17px] leading-snug font-semibold">{NEW_DIALOG_CONFIRM.title}</DialogTitle>
          <DialogDescription className="text-[14px] leading-relaxed text-muted-foreground">
            {NEW_DIALOG_CONFIRM.text}
          </DialogDescription>
        </div>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>{NEW_DIALOG_CONFIRM.stay}</DialogClose>
          <Button type="button" size="lg" onClick={onConfirm}>
            {NEW_DIALOG_CONFIRM.go}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
