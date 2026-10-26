import {Box, Button, Island, LabeledContent, RnText, SegmentedControl} from '@hzblj/kara-ui'
import {Fragment, useEffect, useRef, useState} from 'react'
import {useWindowDimensions} from 'react-native'

import {AnimatedQr, Lead, Notice, Page, Pill, RowDivider, Rows, Section} from '../../components'
import {type ChainAccount, type WalletKeys, walletCrypto} from '../../core'
import {LOOPBACK_CHAINS, type LoopbackChain, type LoopbackRun, runLoopback, type Transmission} from './loopback'

const LABELS = {bitcoin: 'Bitcoin', ethereum: 'Ethereum', solana: 'Solana'} as const

/** BIP-39's published test phrase: a demo key that holds nothing and never leaves memory. */
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const TripRows = ({trip}: {trip: Transmission}) => (
  <Island>
    <Rows>
      <LabeledContent label="Payload" value={`${trip.ur.cbor.length} bytes of CBOR, ${trip.ur.type}`} />
      <RowDivider />
      <LabeledContent label="Fragments" value={String(trip.fragments)} />
      <RowDivider />
      <LabeledContent label="Codes shown, read" value={`${trip.shown}, ${trip.read}`} />
    </Rows>
  </Island>
)

const Lines = ({lines}: {lines: LoopbackRun['review']}) => (
  <Island>
    <Rows>
      {lines.map((line, index) => (
        <Fragment key={line.label}>
          {index > 0 ? <RowDivider /> : null}
          <LabeledContent label={line.label} value={line.value} />
        </Fragment>
      ))}
    </Rows>
  </Island>
)

/**
 * Air-gapped signing on one phone: a demo key (the published test phrase, in memory only) is both the watch-only side
 * and the signer. Its request and answer are real URs, shown as the animated codes another phone would scan, and read
 * through the same decoders by a pretend camera that misses every third code. Nothing is broadcast.
 */
export const LoopbackScreen = () => {
  const crypto = walletCrypto()
  const {width} = useWindowDimensions()
  const demo = useRef<WalletKeys | null>(null)
  const [index, setIndex] = useState(0)
  const [run, setRun] = useState<LoopbackRun | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chain = LOOPBACK_CHAINS[index] ?? 'ethereum'

  useEffect(
    () => () => {
      demo.current?.dispose()
      demo.current = null
    },
    []
  )

  if (!crypto) {
    return null
  }

  const start = async () => {
    setRunning(true)
    setError(null)

    try {
      demo.current ??= await crypto.createEphemeralWallet({mnemonic: DEMO_PHRASE})
      const keys = demo.current
      const account = <Id extends LoopbackChain>(id: Id, n: number) =>
        keys.deriveAccount(
          (id === 'solana' ? {account: n, chain: id} : {chain: id, index: n}) as Parameters<
            typeof keys.deriveAccount
          >[0]
        ) as Promise<ChainAccount<Id>>
      setRun(await runLoopback(crypto, chain, keys.fingerprint, account))
    } catch (failure) {
      setRun(null)
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Page testID="airgap-loopback">
      <Lead>
        Both sides on this phone, with a demo key: a request goes out as QR parts, the signer reads and signs it, the
        answer comes back and is checked against the request. The demo key is the published test phrase, and nothing is
        broadcast.
      </Lead>
      <SegmentedControl
        onChange={next => {
          setIndex(next)
          setRun(null)
        }}
        selectedIndex={index}
        testID="loopback-chain"
        values={LOOPBACK_CHAINS.map(id => LABELS[id])}
      />
      <Island>
        <Button disabled={running} label={running ? 'Running…' : 'Run'} onPress={start} testID="loopback-run" />
      </Island>
      {error ? <Notice text={error} title="The loopback failed" tone="destructive" /> : null}
      {run ? (
        <>
          <Box align="center" gap="s8" row>
            <Pill label="Signed and verified" tone="success" />
            <RnText color="content.secondary" monospacedDigit variant="footnote">
              {`${run.milliseconds} ms, both sides`}
            </RnText>
          </Box>
          <Section caption="What the watch-only side shows: another phone's Signer, Scan, reads it." title="Request">
            <Box align="center">
              <AnimatedQr
                maxFragmentLength={60}
                sha256={crypto.hash.sha256}
                size={width - 80}
                testID="loopback-request"
                ur={run.request.ur}
              />
            </Box>
            <TripRows trip={run.request} />
          </Section>
          <Section
            caption="Read from the bytes to be signed, checked against the signing account."
            title="What the signer read"
          >
            <Lines lines={run.review} />
          </Section>
          <Section title="Answer">
            <Box align="center">
              <AnimatedQr
                maxFragmentLength={60}
                sha256={crypto.hash.sha256}
                size={width - 80}
                testID="loopback-answer"
                ur={run.answer.ur}
              />
            </Box>
            <TripRows trip={run.answer} />
          </Section>
          <Section
            caption="Only an answer that passes these is ever broadcast."
            title="What the watch-only side checked"
          >
            <Lines lines={run.verified} />
          </Section>
        </>
      ) : null}
    </Page>
  )
}
