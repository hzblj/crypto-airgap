import {
  Alert,
  Box,
  Button,
  EmptyState,
  Island,
  LabeledContent,
  RnText,
  SegmentedControl,
  Skeleton,
} from '@hzblj/kara-ui'
import {VERSION} from '@hzblj/nitro-crypto'
import {useRouter} from 'expo-router'
import {Fragment, useState} from 'react'

import {ActionButton, ActionRow, Page, Pill, RowDivider, Rows, Section} from '../../components'
import {NETWORKS} from '../../config'
import {accountPathOf, CHAIN_IDS, lockWallet, removeWallet, walletCrypto} from '../../core'
import {useUnlockedWallet, useWalletStatus} from '../../hooks'
import {type AutoLock, useSessionStore, useWalletStore} from '../../store'
import {shortAddress} from '../../utils'
import {Welcome} from './welcome'

const AUTO_LOCKS: readonly {value: AutoLock; label: string}[] = [
  {label: 'Immediately', value: 'immediately'},
  {label: '1 minute', value: 'minute'},
  {label: '5 minutes', value: 'five-minutes'},
]

const PROTECTION = {
  biometrics: (method: string) => `${method} guards the Keychain item itself: without it, the phrase cannot be read.`,
  none: () => 'This device has no passcode: only the Keychain guards the phrase.',
  passcode: () => 'The app asks for the device passcode before it reads the phrase.',
} as const

/** The unlocked signer: what it can sign for, the two things it does, and how its keys are kept. */
const Signer = () => {
  const router = useRouter()
  const wallet = useUnlockedWallet()
  const crypto = walletCrypto()
  const autoLock = useWalletStore.use.autoLock()
  const setAutoLock = useWalletStore.use.setAutoLock()
  const [confirmRemove, setConfirmRemove] = useState(false)

  if (!wallet || !crypto) {
    return null
  }

  const {accounts, record} = wallet

  return (
    <Page testID="signer">
      <Box gap="s8">
        <Box align="center" gap="s8" row>
          <Pill label="Offline signer" tone="accent" />
          <Pill label={`Fingerprint ${record.fingerprint}`} />
        </Box>
        <RnText color="content.secondary" variant="subheadline">
          This phone holds the keys and needs no network. A watch-only wallet builds a transaction and shows it as a QR
          code; this phone reads it from the bytes to be signed, asks, signs and shows the answer back.
        </RnText>
      </Box>
      <ActionRow>
        <ActionButton
          icon="qr-code-scanner"
          label="Scan to sign"
          onPress={() => router.push('/scan')}
          testID="action-scan"
        />
        <ActionButton icon="qr-code" label="Pair" onPress={() => router.push('/pair')} testID="action-pair" />
      </ActionRow>
      <Section
        caption="Bitcoin and Ethereum sign for any address of the account; Solana for its one account."
        title="Accounts"
      >
        <Island>
          <Rows>
            {CHAIN_IDS.map((chain, index) => {
              const {address, path} = accounts[chain]
              return (
                <Fragment key={chain}>
                  {index > 0 ? <RowDivider /> : null}
                  <LabeledContent
                    label={`${NETWORKS[chain].name} ${chain === 'solana' ? path : accountPathOf(path)}`}
                    testID={`signer-${chain}`}
                    value={shortAddress(address)}
                  />
                </Fragment>
              )
            })}
          </Rows>
        </Island>
      </Section>
      <Section caption={PROTECTION[record.protection](record.method)} title="Security">
        <Island>
          <Rows>
            <LabeledContent label="Unlock with" value={record.method} />
            <RowDivider />
            <LabeledContent
              icon="key"
              label="Show recovery phrase"
              onPress={() => router.push('/recovery-phrase')}
              testID="show-recovery-phrase"
            />
            <RowDivider />
            <LabeledContent icon="lock" label="Lock now" onPress={() => lockWallet()} testID="lock-now" />
          </Rows>
        </Island>
      </Section>
      <Section
        caption="How long the app may sit in the background before the keys are wiped from the engine and it asks again."
        title="Auto-lock"
      >
        <SegmentedControl
          onChange={next => setAutoLock(AUTO_LOCKS[next]?.value ?? 'minute')}
          selectedIndex={Math.max(
            0,
            AUTO_LOCKS.findIndex(option => option.value === autoLock)
          )}
          testID="auto-lock"
          values={AUTO_LOCKS.map(option => option.label)}
        />
      </Section>
      <Section caption="Every key and signature of this signer comes from this engine." title="Engine">
        <Island>
          <Rows>
            <LabeledContent label="@hzblj/nitro-crypto" value={VERSION} />
            <RowDivider />
            <LabeledContent label="Engine" value={`${crypto.info.engineVersion}, C ABI ${crypto.info.abiVersion}`} />
            <RowDivider />
            <LabeledContent label="Secrets in the engine" value={String(crypto.liveHandles())} />
          </Rows>
        </Island>
      </Section>
      <Section
        caption="Removes the recovery phrase from this device's Keychain. Only the words you wrote down can bring the keys back."
        title="Danger zone"
      >
        <Island>
          <Button
            label="Remove the signer from this device"
            onPress={() => setConfirmRemove(true)}
            testID="remove-wallet"
            variant="destructive"
          />
          <Alert
            confirmLabel="Remove"
            destructive
            message="Without your written recovery phrase, these keys are gone for good."
            onConfirm={() => removeWallet()}
            onDismiss={() => setConfirmRemove(false)}
            title="Remove this signer?"
            visible={confirmRemove}
          />
        </Island>
      </Section>
    </Page>
  )
}

/** The Signer tab: the welcome without keys, the signer with them. Locked keys are behind the lock screen. */
export const SignerScreen = () => {
  const status = useWalletStatus()
  const problem = useSessionStore.use.problem()

  switch (status) {
    case 'loading':
      return (
        <Page>
          <Skeleton h={14} w="40%" />
          <Skeleton h={120} w="100%" />
        </Page>
      )
    case 'unavailable':
      return (
        <Page>
          <Island>
            <EmptyState description={problem ?? undefined} icon="warning-filled" title="No native engine" />
          </Island>
        </Page>
      )
    case 'empty':
      return (
        <Page>
          <Welcome />
        </Page>
      )
    default:
      return <Signer />
  }
}
