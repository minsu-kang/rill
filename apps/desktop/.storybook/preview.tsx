import type { Preview } from '@storybook/react-vite'
import type { Locale } from '../src/i18n'
import { ThemeProvider, type Theme } from '../src/theme/ThemeProvider'

const preview: Preview = {
  parameters: { layout: 'fullscreen' },
  initialGlobals: { theme: 'light', locale: 'ko' },
  globalTypes: {
    theme: {
      description: 'Color theme',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        dynamicTitle: true,
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
      },
    },
    locale: {
      description: 'Language',
      toolbar: {
        title: 'Language',
        icon: 'globe',
        dynamicTitle: true,
        items: [
          { value: 'ko', title: '한국어' },
          { value: 'en', title: 'English' },
        ],
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme: Theme = context.globals.theme === 'dark' ? 'dark' : 'light'
      const locale: Locale = context.globals.locale === 'en' ? 'en' : 'ko'
      return (
        <ThemeProvider theme={theme} locale={locale}>
          <Story />
        </ThemeProvider>
      )
    },
  ],
}

export default preview
