import { useCallback, useEffect, useRef, useState } from 'react'

export interface PendingConfirm<Text extends string> {
  text: Text
  workflowId: string | undefined
  settle(ok: boolean): void
}

export interface ConfirmApi<Text extends string> {
  pending: PendingConfirm<Text> | undefined
  confirm(text: Text, effects?: { workflowId: string }): Promise<boolean>
}

export function useConfirm<Text extends string>(): ConfirmApi<Text> {
  const [pending, setPending] = useState<PendingConfirm<Text> | undefined>(undefined)
  const current = useRef<PendingConfirm<Text> | undefined>(undefined)

  useEffect(
    () => () => {
      current.current?.settle(false)
    },
    [],
  )

  const confirm = useCallback(
    (text: Text, effects?: { workflowId: string }): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        current.current?.settle(false)
        const next: PendingConfirm<Text> = {
          text,
          workflowId: effects?.workflowId,
          settle: (ok) => {
            if (current.current === next) {
              current.current = undefined
              setPending(undefined)
            }
            resolve(ok)
          },
        }
        current.current = next
        setPending(next)
      }),
    [],
  )

  return { pending, confirm }
}
