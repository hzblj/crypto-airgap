import {Stack} from 'expo-router'

import {TabStack} from '../../../src/components'
import {useWalletStatus} from '../../../src/hooks'

/** Everything past the signer's own screen needs its keys unlocked: locking or removing them closes those screens. */
export default function SignerLayout() {
  const status = useWalletStatus()

  return (
    <TabStack title="Signer">
      <Stack.Screen name="index" />
      <Stack.Protected guard={status === 'unlocked'}>
        <Stack.Screen name="scan" />
        <Stack.Screen name="airgap-review" />
        <Stack.Screen name="pair" />
        <Stack.Screen name="recovery-phrase" />
      </Stack.Protected>
    </TabStack>
  )
}
