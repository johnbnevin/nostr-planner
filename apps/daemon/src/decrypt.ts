/**
 * NIP-44 decryption using the bot's private key.
 */

import * as nip44 from "nostr-tools/nip44";

/**
 * Decrypt NIP-44 content from a user (identified by their pubkey)
 * using the bot's private key.
 */
export function decryptFromUser(
  botPrivkey: Uint8Array,
  userPubkey: string,
  ciphertext: string
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(botPrivkey, userPubkey);
  return nip44.v2.decrypt(ciphertext, conversationKey);
}
