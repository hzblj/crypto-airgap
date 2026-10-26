import type {StateCreator} from 'zustand'

/**
 * How the stored recovery phrase is guarded:
 * - `biometrics`: the Keychain (Keystore on Android) item itself requires Face ID or a fingerprint to be read;
 * - `passcode`: the item is readable while the device is unlocked, and the app asks for the device passcode first;
 * - `none`: a device without either (a simulator), where only the Keychain's this-device-only rule applies.
 */
export type Protection = 'biometrics' | 'passcode' | 'none'

/** What is known about the signer without unlocking it: nothing secret. The phrase itself is in the Keychain. */
export type WalletRecord = {
  readonly createdAt: Date
  /** The seed's BIP-32 fingerprint, hex: how an unlocked wallet proves it is this one. */
  readonly fingerprint: string
  readonly words: number
  readonly origin: 'created' | 'imported'
  readonly protection: Protection
  /** "Face ID", "Touch ID", "Biometrics", "Passcode", "None": what the screens call it. */
  readonly method: string
}

/** How long the app may sit in the background before the keys are wiped from the engine. */
export type AutoLock = 'immediately' | 'minute' | 'five-minutes'

export type RecordSlice = {
  record: WalletRecord | null
  setRecord: (record: WalletRecord) => void
}

export type SettingsSlice = {
  autoLock: AutoLock
  setAutoLock: (autoLock: AutoLock) => void
}

export type WalletStore = RecordSlice &
  SettingsSlice & {
    /** Back to a device without a signer: the record and the settings. */
    resetWallet: () => void
  }

type Creator<Slice> = StateCreator<WalletStore, [['zustand/immer', never]], [], Slice>

export type CreateRecordSlice = Creator<RecordSlice>
export type CreateSettingsSlice = Creator<SettingsSlice>
