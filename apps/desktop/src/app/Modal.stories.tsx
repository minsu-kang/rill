import type { Meta, StoryObj } from '@storybook/react-vite'
import { Modal } from './Modal'

const meta: Meta<typeof Modal> = { title: 'App/Modal', component: Modal, args: { title: '제목', onClose: () => undefined, children: <p>본문 내용이에요.</p> } }
export default meta
type Story = StoryObj<typeof Modal>

export const Basic: Story = {}
export const Wide: Story = { args: { wide: true, footer: <button type="button">확인</button> } }
