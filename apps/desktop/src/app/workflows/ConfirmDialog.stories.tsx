import type { Meta, StoryObj } from '@storybook/react-vite'
import { ConfirmDialog } from './ConfirmDialog'

const meta: Meta<typeof ConfirmDialog> = {
  title: 'App/Workflows/ConfirmDialog',
  component: ConfirmDialog,
  args: { title: '연결을 삭제할까요?', message: '이 연결을 쓰는 워크플로우가 실패해요.', confirmLabel: '삭제하기', cancelLabel: '취소', onConfirm: () => undefined, onCancel: () => undefined },
}
export default meta
type Story = StoryObj<typeof ConfirmDialog>

export const Plain: Story = {}
export const WithDetails: Story = { args: { details: <ul><li>Slack 메시지 · notify</li><li>HTTP 요청 · forward</li></ul> } }
export const Danger: Story = { args: { title: '이 워크플로우를 삭제할까요?', message: '“영수증 정리” 워크플로우와 실행 기록이 모두 삭제돼요. 되돌릴 수 없어요.', confirmLabel: '워크플로우 삭제', danger: true } }
export const Busy: Story = { args: { busy: true } }
export const WithError: Story = { args: { error: '삭제하지 못했어요.' } }
