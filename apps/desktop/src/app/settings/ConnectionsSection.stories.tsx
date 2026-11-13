import type { Meta, StoryObj } from '@storybook/react-vite'
import { fakeSettings } from '../../engine/fake-host'
import type { ConnectionSummary, OAuthState } from '../../shared/host-api'
import { SettingsStage } from './SettingsStage'

const meta: Meta<typeof SettingsStage> = { title: 'App/Settings/ConnectionsSection', component: SettingsStage, args: { section: 'connections' } }
export default meta
type Story = StoryObj<typeof SettingsStage>

type Play = NonNullable<Story['play']>
type Context = Parameters<Play>[0]

const ONLINE: OAuthState = { available: true, accounts: [] }
const SIGNED_IN: OAuthState = {
  available: true,
  accounts: [
    { provider: 'google', account: 'minsu@example.com' },
    { provider: 'microsoft', account: 'minsu@contoso.example' },
  ],
}

const CUSTOM: ConnectionSummary[] = [
  { name: 'open-data', kind: 'http', authType: 'none' },
  { name: 'billing-api', kind: 'http', authType: 'apiKey' },
  { name: 'crm', kind: 'http', authType: 'bearer' },
  { name: 'legacy-portal', kind: 'http', authType: 'basic' },
  { name: 'older-http-secret', kind: 'http' },
]
const WEBHOOKS: ConnectionSummary[] = [
  { name: 'team-alerts', kind: 'slack' },
  { name: 'billing-alerts', kind: 'slack' },
]
const OTHER: ConnectionSummary[] = [{ name: 'shop-webhook', kind: 'webhookSecret' }]

const init = (settings: Parameters<typeof fakeSettings>[0]) => ({ settings: fakeSettings(settings) })

async function chooseType({ canvas, userEvent }: Context, type: string): Promise<void> {
  const [select] = await canvas.findAllByRole('combobox')
  await userEvent.selectOptions(select!, type)
}

async function textFields({ canvas }: Context): Promise<HTMLElement[]> {
  return canvas.findAllByRole('textbox')
}

function secretFields(context: Context): HTMLInputElement[] {
  return [...context.canvasElement.querySelectorAll<HTMLInputElement>('input[type="password"]')]
}

function saveButton(context: Context): HTMLElement {
  return context.canvasElement.querySelector('button[type="submit"]')!
}

async function openSlack({ canvas, userEvent }: Context): Promise<void> {
  const buttons = await canvas.findAllByRole('button', { expanded: false })
  await userEvent.click(buttons[0]!)
}

export const Empty: Story = { args: { init: init({ oauth: ONLINE }) } }

export const OAuthUnavailable: Story = { args: { init: init({ connections: [...CUSTOM, ...WEBHOOKS] }) } }

export const OAuthConnected: Story = { args: { init: init({ oauth: SIGNED_IN }) } }

export const Filled: Story = { args: { init: init({ oauth: SIGNED_IN, connections: [...WEBHOOKS, ...CUSTOM, ...OTHER] }) } }

export const NoKeychain: Story = { args: { init: init({ encryptionAvailable: false, oauth: ONLINE, connections: [...WEBHOOKS, ...CUSTOM] }) } }

export const SlackAdvancedOpen: Story = { args: { init: init({ oauth: ONLINE }) }, play: openSlack }

export const SlackAdvancedOpenWithSaved: Story = { args: { init: init({ oauth: ONLINE, connections: WEBHOOKS }) }, play: openSlack }

export const SlackWebhookNotAUrl: Story = {
  args: { init: init({ oauth: ONLINE }) },
  play: async (context) => {
    await openSlack(context)
    const [name] = await textFields(context)
    await context.userEvent.type(name!, 'ops')
    await context.userEvent.type(secretFields(context)[0]!, 'not a url')
  },
}

export const SlackWebhookDuplicateName: Story = {
  args: { init: init({ oauth: ONLINE, connections: [...WEBHOOKS, ...CUSTOM] }) },
  play: async (context) => {
    await openSlack(context)
    const [name] = await textFields(context)
    await context.userEvent.type(name!, 'BILLING-API')
    await context.userEvent.type(secretFields(context)[0]!, 'https://hooks.slack.com/services/T000/B000/XXXX')
    await context.userEvent.click(saveButton(context))
  },
}

export const AuthNoAuth: Story = { args: { init: init({ oauth: ONLINE }) } }

export const AuthApiKeyInHeader: Story = {
  args: { init: init({ oauth: ONLINE }) },
  play: (context) => chooseType(context, 'apiKey'),
}

export const AuthApiKeyInQuery: Story = {
  args: { init: init({ oauth: ONLINE }) },
  play: async (context) => {
    await chooseType(context, 'apiKey')
    const selects = await context.canvas.findAllByRole('combobox')
    await context.userEvent.selectOptions(selects[1]!, 'query')
  },
}

export const AuthBearerToken: Story = {
  args: { init: init({ oauth: ONLINE }) },
  play: (context) => chooseType(context, 'bearer'),
}

export const AuthBasic: Story = {
  args: { init: init({ oauth: ONLINE }) },
  play: (context) => chooseType(context, 'basic'),
}

export const FormFilled: Story = {
  args: { init: init({ oauth: ONLINE }) },
  play: async (context) => {
    await chooseType(context, 'apiKey')
    const [name, keyName] = await textFields(context)
    await context.userEvent.type(name!, 'weather-api')
    await context.userEvent.type(keyName!, 'X-Api-Key')
    await context.userEvent.type(secretFields(context)[0]!, 'example-value-1234')
  },
}

export const SavedJustNow: Story = {
  args: { init: init({ oauth: ONLINE }) },
  play: async (context) => {
    await chooseType(context, 'bearer')
    const [name] = await textFields(context)
    await context.userEvent.type(name!, 'crm')
    await context.userEvent.type(secretFields(context)[0]!, 'example-token-1234')
    await context.userEvent.click(saveButton(context))
    await context.canvas.findByRole('status')
  },
}

export const ErrorMissingFields: Story = {
  args: { init: init({ oauth: ONLINE }) },
  play: async (context) => {
    await chooseType(context, 'bearer')
    const [name] = await textFields(context)
    await context.userEvent.type(name!, 'crm')
    await context.userEvent.click(saveButton(context))
    await context.canvas.findByRole('alert')
  },
}

export const ErrorInvalidKeyName: Story = {
  args: { init: init({ oauth: ONLINE }) },
  play: async (context) => {
    await chooseType(context, 'apiKey')
    const [name, keyName] = await textFields(context)
    await context.userEvent.type(name!, 'weather-api')
    await context.userEvent.type(keyName!, 'bad name')
    await context.userEvent.type(secretFields(context)[0]!, 'example-value-1234')
    await context.userEvent.click(saveButton(context))
    await context.canvas.findByRole('alert')
  },
}

export const ErrorDuplicateName: Story = {
  args: { init: init({ oauth: ONLINE, connections: CUSTOM }) },
  play: async (context) => {
    await chooseType(context, 'bearer')
    const [name] = await textFields(context)
    await context.userEvent.type(name!, 'Billing-API')
    await context.userEvent.type(secretFields(context)[0]!, 'example-token-1234')
    await context.userEvent.click(saveButton(context))
    await context.canvas.findByRole('alert')
  },
}

export const OtherSecretsOnly: Story = { args: { init: init({ oauth: ONLINE, connections: OTHER }) } }

export const LimitReached: Story = {
  args: {
    init: init({
      oauth: ONLINE,
      connections: Array.from({ length: 200 }, (_, index): ConnectionSummary => ({ name: `connection-${index + 1}`, kind: 'http', authType: 'bearer' })),
    }),
  },
}
