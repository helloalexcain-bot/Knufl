/**
 * Produces the same stable UUID for a confirmed operation on client and server.
 * This lets an offline dependent action reference the record that its queued
 * predecessor will create, without trusting a model-supplied owner identifier.
 */
export const deterministicUuid = async (
  userId: string,
  scope: string,
  operationKey: string,
): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`knufl:${userId}:${scope}:${operationKey}`),
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
