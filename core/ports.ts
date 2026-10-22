/** Credential protection is supplied by the host, never by the core runtime. */
export interface SecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
