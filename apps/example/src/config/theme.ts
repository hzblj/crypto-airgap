import {adaptive, defineTheme} from '@hzblj/kara-ui'

/**
 * An indigo accent, the icon's, apart from the Nitro Wallet's emerald so the two examples never pass for each other:
 * every accent token is set in one place, and the Android seed moves with them.
 */
export const theme = defineTheme({
  colors: {
    border: {accent: '#4f46e5'},
    content: {accent: adaptive({dark: '#a5b4fc', light: '#4338ca'})},
    fill: {
      accent: {
        base: adaptive({dark: '#4f46e533', light: '#e7e8fd'}),
        disabled: adaptive({dark: '#4f46e51f', light: '#c9ccfa'}),
        primary: '#4f46e5',
      },
    },
    shadow: {btn: {accent: {ring: adaptive({dark: '#4f46e500', light: '#b9bdf8'})}}},
  },
  materialSeed: '#4f46e5',
})
