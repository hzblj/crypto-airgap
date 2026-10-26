import {Box, Button, Island, RnIcon, RnText, VStack} from '@hzblj/kara-ui'
import {useRouter} from 'expo-router'

import {Notice} from '../../components'

/** The first screen of a device without keys: create them, or bring a recovery phrase. */
export const Welcome = () => {
  const router = useRouter()

  return (
    <Box gap="s32" pt="s24" testID="welcome">
      <Box align="center" gap="s16">
        <Box align="center" bg="fill.accent.base" borderRadius="full" h={88} justify="center" w={88}>
          <RnIcon color="content.accent" name="qr-code" size="s48" />
        </Box>
        <RnText align="center" variant="headingM">
          An air-gapped signer
        </RnText>
        <RnText align="center" color="content.secondary" variant="body">
          This phone keeps the keys for Ethereum, Bitcoin and Solana, and signs over QR codes for a watch-only wallet:
          another phone's Watch-only tab, Sparrow or MetaMask. It needs no network. Or skip the keys and use the
          Watch-only and Loopback tabs.
        </RnText>
      </Box>
      <Island>
        <VStack spacing="s12" wide>
          <Button label="Create new keys" onPress={() => router.push('/onboarding/create')} testID="create-wallet" />
          <Button
            label="I have a recovery phrase"
            onPress={() => router.push('/onboarding/import')}
            testID="import-wallet"
            variant="secondary"
          />
        </VStack>
      </Island>
      <Notice
        text="Sepolia, Bitcoin testnet4 and Solana devnet only. Testnet coins are free from faucets and worth nothing: never use these keys for real funds."
        title="Testnets only"
        tone="warning"
      />
    </Box>
  )
}
